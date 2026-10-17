import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { logFailure } from "../../../shared/logFailure";
import { GameRendererUnavailableError } from "./GameRendererRpc";
import type { DesktopWindows } from "../../window/DesktopWindows";

export const logGameRendererRequestFailure = Effect.fnUntraced(function* (
  windows: Pick<DesktopWindows["Service"], "describe">,
  rendererId: number,
  operation: string,
  cause: Cause.Cause<unknown>,
) {
  if (Cause.hasInterruptsOnly(cause)) return false;
  if (
    cause.reasons.every((reason) => {
      if (!Cause.isFailReason(reason)) return false;
      const error =
        reason.error instanceof Error &&
        reason.error.cause instanceof GameRendererUnavailableError
          ? reason.error.cause
          : reason.error;
      return (
        error instanceof GameRendererUnavailableError &&
        error.cause === undefined &&
        (error.detail === "The connection was unavailable." ||
          error.detail === "The game is still loading. Try again in a moment.")
      );
    })
  )
    return false;
  if (!Cause.hasDies(cause) && !(yield* windows.describe(rendererId))?.ready) {
    return false;
  }
  yield* logFailure("Game renderer request failed", cause, {
    failure: "warning",
  }).pipe(
    Effect.annotateLogs({
      component: "game-renderer",
      data: { rendererId, operation },
      repeatKey: `${rendererId}:${operation}`,
    }),
  );
  return true;
});
