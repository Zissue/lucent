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
      const error = reason.error;
      return (
        error instanceof GameRendererUnavailableError &&
        error.cause === undefined &&
        (error.reason === "disconnected" || error.reason === "loading")
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
