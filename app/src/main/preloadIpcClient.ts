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

export const createSubscribe =
  (transport: IpcEventTransport) =>
  <Payload>(
    descriptor: IpcEventDescriptor<Payload>,
    listener: (payload: Payload) => void,
  ): (() => void) => {
    const subscription = (rawPayload: unknown): void => {
      try {
        listener(descriptor.decodePayload(rawPayload));
      } catch (cause) {
        console.error(`Failed to decode ${descriptor.name} event`, cause);
      }
    };

    transport.on(descriptor.channel, subscription);
    return () => {
      transport.removeListener(descriptor.channel, subscription);
    };
  };
