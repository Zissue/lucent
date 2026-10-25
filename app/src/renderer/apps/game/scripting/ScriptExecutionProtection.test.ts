import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  protectScriptExecution,
  protectScriptExecutionUntil,
} from "./ScriptExecutionProtection";

const makeBridge = () => {
  const begin = vi.fn(async (): Promise<void> => undefined);
  const finish = vi.fn(async (): Promise<void> => undefined);
  vi.stubGlobal("window", {
    desktop: {
      view: "game",
      gameRenderer: {
        beginScriptExecution: begin,
        finishScriptExecution: finish,
      },
    },
  });
  return { begin, finish };
};

afterEach(() => vi.unstubAllGlobals());

describe("ScriptExecutionProtection", () => {
  it.effect("disarms a completed execution without a token", () =>
    Effect.gen(function* () {
      const { begin, finish } = makeBridge();
      expect(yield* protectScriptExecution(Effect.succeed("finished"))).toBe(
        "finished",
      );
      expect(begin.mock.calls).toEqual([[]]);
      expect(finish.mock.calls).toEqual([[]]);
    }),
  );

  it.effect("keeps recovery armed until asynchronous execution completes", () =>
    Effect.gen(function* () {
      const { begin, finish } = makeBridge();
      const terminal = yield* Deferred.make<void>();
      const disarmed = yield* Deferred.make<void>();
      finish.mockImplementation(async () => {
        Deferred.doneUnsafe(disarmed, Effect.void);
      });
      yield* protectScriptExecutionUntil(Deferred.await(terminal));
      expect(begin.mock.calls).toEqual([[]]);
      expect(finish.mock.calls).toEqual([]);
      yield* Deferred.succeed(terminal, undefined);
      yield* Deferred.await(disarmed);
      expect(finish.mock.calls).toEqual([[]]);
    }),
  );
});
