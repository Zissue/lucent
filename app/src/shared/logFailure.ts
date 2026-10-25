import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const logFailure = (
  message: string,
  cause: Cause.Cause<unknown>,
  options?: { readonly failure?: "debug" | "warning" | "error" },
): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  /* oxlint-disable lucent/log-message-literal -- logFailure forwards its caller's message; the rule checks logFailure callers instead. */
  if (Cause.hasDies(cause)) return Effect.logError(message, cause);
  switch (options?.failure ?? "debug") {
    case "error":
      return Effect.logError(message, cause);
    case "warning":
      return Effect.logWarning(message, cause);
    case "debug":
      return Effect.logDebug(message, cause);
  }
  /* oxlint-enable lucent/log-message-literal */
};
