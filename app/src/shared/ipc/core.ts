import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type IpcSchema<T> = Schema.Codec<T, unknown, never, never>;

export interface IpcInvokeDescriptor<Payload, Result> {
  readonly channel: string;
  decodePayloadEffect(
    input: unknown,
  ): Effect.Effect<Payload, Schema.SchemaError>;
  decodeResult(input: unknown): Result;
  encodePayload(input: Payload): unknown;
  encodeResultEffect(input: Result): Effect.Effect<unknown, Schema.SchemaError>;
  readonly name: string;
  readonly payload: IpcSchema<Payload>;
  readonly result: IpcSchema<Result>;
}

export interface IpcEventDescriptor<Payload> {
  readonly channel: string;
  decodePayload(input: unknown): Payload;
  encodePayloadEffect(
    input: Payload,
  ): Effect.Effect<unknown, Schema.SchemaError>;
  readonly name: string;
  readonly payload: IpcSchema<Payload>;
}

export type IpcInvokePayload<
  Descriptor extends IpcInvokeDescriptor<unknown, unknown>,
> =
  Descriptor extends IpcInvokeDescriptor<infer Payload, unknown>
    ? Payload
    : never;

export type IpcInvokeResult<
  Descriptor extends IpcInvokeDescriptor<unknown, unknown>,
> =
  Descriptor extends IpcInvokeDescriptor<unknown, infer Result>
    ? Result
    : never;

export type IpcEventPayload<Descriptor extends IpcEventDescriptor<unknown>> =
  Descriptor extends IpcEventDescriptor<infer Payload> ? Payload : never;

export interface IpcBridgeError {
  readonly channel?: string;
  readonly code: string;
  readonly message: string;
}

export type IpcInvokeEnvelope<Result> =
  | {
      readonly ok: true;
      readonly value: Result;
    }
  | {
      readonly error: IpcBridgeError;
      readonly ok: false;
    };

const ipcDecodeOptions = { onExcessProperty: "error" } as const;

export const defineInvoke = <Payload, Result>(descriptor: {
  readonly channel: string;
  readonly name: string;
  readonly payload: IpcSchema<Payload>;
  readonly result: IpcSchema<Result>;
}): IpcInvokeDescriptor<Payload, Result> => ({
  channel: descriptor.channel,
  decodePayloadEffect: Schema.decodeUnknownEffect(
    descriptor.payload,
    ipcDecodeOptions,
  ),
  decodeResult: Schema.decodeUnknownSync(descriptor.result, ipcDecodeOptions),
  encodePayload: Schema.encodeSync(descriptor.payload),
  encodeResultEffect: Schema.encodeEffect(descriptor.result),
  name: descriptor.name,
  payload: descriptor.payload,
  result: descriptor.result,
});

export const defineEvent = <Payload>(descriptor: {
  readonly channel: string;
  readonly name: string;
  readonly payload: IpcSchema<Payload>;
}): IpcEventDescriptor<Payload> => ({
  channel: descriptor.channel,
  decodePayload: Schema.decodeUnknownSync(descriptor.payload, ipcDecodeOptions),
  encodePayloadEffect: Schema.encodeEffect(descriptor.payload),
  name: descriptor.name,
  payload: descriptor.payload,
});
