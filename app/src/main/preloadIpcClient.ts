import { ipcRenderer, type IpcRendererEvent } from "electron";
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
    listener: (event: IpcRendererEvent, rawPayload: unknown) => void,
  ) => void;
  readonly removeListener: (
    channel: string,
    listener: (event: IpcRendererEvent, rawPayload: unknown) => void,
  ) => void;
};

export class DesktopBridgeError extends Error {
  override name = "DesktopBridgeError";
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
      throw new DesktopBridgeError(envelope.message);
    }
    return envelope.value as Result;
  };

export const writeRendererLog = (record: unknown): void => {
  try {
    ipcRenderer.send(RendererLogIpc.record.channel, desktopLogJsonSafe(record));
  } catch {}
};

const eventFailureLogger = Logger.make((options) => {
  try {
    const { level, message, component, data, repeatKey, error } =
      desktopLogRecord(options);
    writeRendererLog({ level, message, component, data, repeatKey, error });
  } catch {}
});

export const createSubscribe =
  (transport: IpcEventTransport) =>
  <Payload>(
    descriptor: IpcEventDescriptor<Payload>,
    listener: (payload: Payload) => void,
  ): (() => void) => {
    let failed = false;
    const subscription = (
      _event: IpcRendererEvent,
      rawPayload: unknown,
    ): void => {
      try {
        listener(rawPayload as Payload);
        failed = false;
      } catch {
        if (failed) return;
        failed = true;
        const cause = Cause.die(new Error("IPC event callback failed"));
        Effect.runSync(
          logFailure("Renderer event handler failed", cause).pipe(
            Effect.annotateLogs({
              component: "preload",
              data: { channel: descriptor.channel },
              repeatKey: descriptor.channel,
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
