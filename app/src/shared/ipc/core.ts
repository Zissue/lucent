import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type IpcSchema<T> = Schema.Codec<T, unknown, never, never>;

export interface IpcInvokeDescriptor<Payload, Result> {
  readonly channel: string;
  decodePayloadEffect(
    input: unknown,
  ): Effect.Effect<Payload, Schema.SchemaError>;
  encodePayload(input: Payload): unknown;
  encodeResultEffect(input: Result): Effect.Effect<unknown, Schema.SchemaError>;
}

export interface IpcEventDescriptor<Payload> {
  readonly channel: string;
  decodePayload(input: unknown): Payload;
  encodePayload(input: Payload): unknown;
  encodePayloadEffect(
    input: Payload,
  ): Effect.Effect<unknown, Schema.SchemaError>;
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

export type IpcInvokeEnvelope<Result> =
  | {
      readonly ok: true;
      readonly value: Result;
    }
  | {
      readonly message: string;
      readonly ok: false;
    };

const ipcDecodeOptions = { onExcessProperty: "error" } as const;

export const defineInvoke = <Payload, Result>(descriptor: {
  readonly channel: string;
  readonly payload: IpcSchema<Payload>;
  readonly result: IpcSchema<Result>;
}): IpcInvokeDescriptor<Payload, Result> => ({
  channel: descriptor.channel,
  decodePayloadEffect: Schema.decodeUnknownEffect(
    descriptor.payload,
    ipcDecodeOptions,
  ),
  encodePayload: Schema.encodeSync(descriptor.payload),
  encodeResultEffect: Schema.encodeEffect(descriptor.result),
});

export const defineEvent = <Payload>(descriptor: {
  readonly channel: string;
  readonly payload: IpcSchema<Payload>;
}): IpcEventDescriptor<Payload> => ({
  channel: descriptor.channel,
  decodePayload: Schema.decodeUnknownSync(descriptor.payload, ipcDecodeOptions),
  encodePayload: Schema.encodeSync(descriptor.payload),
  encodePayloadEffect: Schema.encodeEffect(descriptor.payload),
});
