import type { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export const listen = (
  target: Pick<EventEmitter, "on" | "removeListener">,
  event: string,
  listener: Parameters<EventEmitter["on"]>[1],
  shouldRemove: () => boolean = () => true,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      target.on(event, listener);
    }),
    () =>
      Effect.sync(() => {
        if (shouldRemove()) target.removeListener(event, listener);
      }),
  );
