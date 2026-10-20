import { EventEmitter } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listen } from "./NativeListener";

describe("NativeListener", () => {
  it.effect(
    "runs synchronously and removes the listener when its scope closes",
    () =>
      Effect.gen(function* () {
        const target = new EventEmitter();
        const received: number[] = [];
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* listen(target, "value", (value: number) => {
              received.push(value);
            });
            target.emit("value", 1);
            expect(received).toEqual([1]);
            expect(target.listenerCount("value")).toBe(1);
          }),
        );
        target.emit("value", 2);
        expect(received).toEqual([1]);
        expect(target.listenerCount("value")).toBe(0);
      }),
  );
});
