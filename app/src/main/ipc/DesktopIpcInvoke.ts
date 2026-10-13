import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import {
  type IpcBridgeError,
  type IpcInvokeDescriptor,
  type IpcInvokeEnvelope,
} from "../../shared/ipc";

const errorMessage = (cause: unknown, fallback: string): string => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return typeof cause === "string" && cause.length > 0 ? cause : fallback;
};

const bridgeError = (
  channel: string,
  code: string,
  cause: unknown,
): IpcBridgeError => {
  const fallback = `IPC request failed on channel "${channel}".`;
  return {
    channel,
    code,
    message: Cause.isCause(cause)
      ? errorMessage(Cause.squash(cause), fallback)
      : errorMessage(cause, fallback),
  };
};

export const createDesktopIpcInvokeHandler =
  <Payload, Result, Event, HandlerContext>(
    descriptor: IpcInvokeDescriptor<Payload, Result>,
    handler: (
      payload: Payload,
      event: Event,
    ) => Effect.Effect<Result, unknown, HandlerContext>,
    runPromise: <A, E>(
      effect: Effect.Effect<A, E, HandlerContext>,
    ) => Promise<A>,
  ) =>
  (event: Event, rawPayload: unknown): Promise<IpcInvokeEnvelope<unknown>> =>
    runPromise(
      descriptor.decodePayloadEffect(rawPayload).pipe(
        Effect.flatMap((payload) => handler(payload, event)),
        Effect.flatMap((result) =>
          descriptor.encodeResultEffect(result).pipe(Effect.orDie),
        ),
        Effect.map(
          (value) => ({ ok: true, value }) satisfies IpcInvokeEnvelope<unknown>,
        ),
        Effect.tapCauseIf(
          (cause) => Cause.hasDies(cause) || Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logError("IPC handler failed unexpectedly", cause).pipe(
              Effect.annotateLogs({
                component: "ipc",
                data: { channel: descriptor.channel },
              }),
            ),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed({
            ok: false,
            error: bridgeError(descriptor.channel, "IPC_HANDLER_FAILED", cause),
          } satisfies IpcInvokeEnvelope<unknown>),
        ),
      ),
    );
