import { ipcRenderer } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { logFailure } from "../shared/logFailure";
import { desktopLogJsonSafe, desktopLogRecord } from "../shared/logRecord";
import { RendererLogIpc } from "../shared/ipc/rendererLog";

import type {
  IpcEventDescriptor,
  IpcInvokeDescriptor,
  IpcInvokeEnvelope,
} from "../shared/ipc";

export type IpcInvokeTransport = (
  channel: string,
  payload: unknown,
) => Promise<IpcInvokeEnvelope<unknown>>;

export type IpcEventTransport = {
  readonly on: (
    channel: string,
    listener: (rawPayload: unknown) => void,
  ) => void;
  readonly removeListener: (
    channel: string,
    listener: (rawPayload: unknown) => void,
  ) => void;
};

export class DesktopBridgeError extends Error {
  readonly code: string;
  readonly channel?: string;

  constructor(error: {
    readonly channel?: string;
    readonly code: string;
    readonly message: string;
  }) {
    super(error.message);
    this.name = "DesktopBridgeError";
    this.code = error.code;
    if (error.channel !== undefined) {
      this.channel = error.channel;
    }
  }
}

export const createInvoke =
  (transport: IpcInvokeTransport) =>
  async <Payload, Result>(
    descriptor: IpcInvokeDescriptor<Payload, Result>,
    payload: Payload,
  ): Promise<Result> => {
    const encodedPayload = descriptor.encodePayload(payload);
    const envelope = await transport(descriptor.channel, encodedPayload);
    if (!envelope.ok) {
      throw new DesktopBridgeError(envelope.error);
    }
    return descriptor.decodeResult(envelope.value);
  };

const eventFailureLogger = Logger.make((options) => {
  try {
    const { level, message, component, data, repeatKey, error } =
      desktopLogRecord(options);
    ipcRenderer.send(
      RendererLogIpc.record.channel,
      desktopLogJsonSafe({ level, message, component, data, repeatKey, error }),
    );
  } catch {}
});

export const createSubscribe =
  (transport: IpcEventTransport) =>
  <Payload>(
    descriptor: IpcEventDescriptor<Payload>,
    listener: (payload: Payload) => void,
  ): (() => void) => {
    const failed = { decode: false, callback: false };
    const subscription = (rawPayload: unknown): void => {
      let phase: "decode" | "callback" = "decode";
      try {
        const payload = descriptor.decodePayload(rawPayload);
        failed.decode = false;
        phase = "callback";
        listener(payload);
        failed.callback = false;
      } catch {
        if (failed[phase]) return;
        failed[phase] = true;
        const cause = Cause.die(
          new Error(
            phase === "decode"
              ? "IPC event decoding failed"
              : "IPC event callback failed",
          ),
        );
        Effect.runSync(
          logFailure("Renderer event handler failed", cause).pipe(
            Effect.annotateLogs({
              component: "preload",
              data: {
                channel: descriptor.channel,
                eventName: descriptor.name,
                phase,
              },
              repeatKey: `${descriptor.channel}:${descriptor.name}:${phase}`,
            }),
            Effect.provideService(
              References.CurrentLoggers,
              new Set([eventFailureLogger]),
            ),
          ),
        );
      }
    };

    transport.on(descriptor.channel, subscription);
    return () => {
      transport.removeListener(descriptor.channel, subscription);
    };
  };
