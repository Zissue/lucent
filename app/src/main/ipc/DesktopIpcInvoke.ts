import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import {
  type IpcInvokeDescriptor,
  type IpcInvokeEnvelope,
} from "../../shared/ipc";
import { logFailure } from "../../shared/logFailure";

const failureTag = (error: unknown): string =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
    ? error._tag
    : "UnknownError";

const errorMessage = (cause: unknown, fallback: string): string => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return typeof cause === "string" && cause.length > 0 ? cause : fallback;
};

const bridgeErrorMessage = (channel: string, cause: unknown): string => {
  const fallback = `IPC request failed on channel "${channel}".`;
  return Cause.isCause(cause)
    ? errorMessage(Cause.squash(cause), fallback)
    : errorMessage(cause, fallback);
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
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!Cause.hasInterruptsOnly(cause)) {
              const logCause = Cause.map(cause, failureTag);
              yield* (
                Cause.hasDies(cause)
                  ? logFailure("IPC handler failed unexpectedly", logCause)
                  : logFailure("IPC handler failed", logCause, {
                      failure: "warning",
                    })
              ).pipe(
                Effect.annotateLogs({
                  component: "ipc",
                  data: { channel: descriptor.channel },
                  repeatKey: descriptor.channel,
                }),
              );
            }
            return {
              ok: false,
              message: bridgeErrorMessage(descriptor.channel, cause),
            } satisfies IpcInvokeEnvelope<unknown>;
          }),
        ),
      ),
    );
