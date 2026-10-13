import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";

import { ElectronApp } from "../electron/ElectronApp";
import {
  DesktopLifecycle,
  layer as desktopLifecycleLayer,
} from "./DesktopLifecycle";
import { DesktopObservability } from "./observability/DesktopObservability";

vi.mock("electron", () => ({ app: {} }));

const TEST_SIGNAL = "SIGTERM";
type ProcessSignalListener = (signal: NodeJS.Signals) => void;

const makeSignal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const makeHarness = (flushCompletes: boolean) => {
  const events: string[] = [];
  const exited = makeSignal();
  const flushStarted = Effect.sync(() => {
    events.push("flush");
  });
  const flush = flushCompletes
    ? flushStarted
    : flushStarted.pipe(Effect.andThen(Effect.never));
  const observability = DesktopObservability.of({
    flush,
    installProcessHooks: Effect.void,
    logFilePath: "lucent.log",
  });
  const app = ElectronApp.of({
    exit: (code) =>
      Effect.sync(() => {
        events.push(`exit:${code}`);
        exited.resolve();
      }),
    getAppMetrics: Effect.succeed([]),
    getVersion: Effect.succeed("1.0.0"),
    on: () => Effect.succeed(() => undefined),
    quit: Effect.void,
    relaunch: Effect.void,
    whenReady: Effect.void,
  });
  const layer = Layer.mergeAll(
    Logger.layer([
      Logger.make((options) => {
        if (options.logLevel === "Error")
          events.push(`error:${String(options.message)}`);
      }),
    ]),
    desktopLifecycleLayer,
    Layer.succeed(DesktopObservability, observability),
    Layer.succeed(ElectronApp, app),
  );

  return { events, exited: exited.promise, layer };
};

const findInstalledSignalListener = (
  previousListeners: ReadonlySet<ProcessSignalListener>,
): ProcessSignalListener => {
  const listener = process
    .listeners(TEST_SIGNAL)
    .find((candidate) => !previousListeners.has(candidate));
  if (listener === undefined) {
    throw new Error(`Expected a ${TEST_SIGNAL} listener`);
  }
  return listener;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DesktopLifecycle", () => {
  it.live("flushes the timeout diagnostic before forcing exit", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const previousListeners = new Set(process.listeners(TEST_SIGNAL));
      const harness = makeHarness(true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle;
          yield* lifecycle.register;
          findInstalledSignalListener(previousListeners)(TEST_SIGNAL);

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
          yield* Effect.promise(() => harness.exited);
        }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.events).toEqual([
        "error:Lucent quit timed out; forcing exit",
        "flush",
        "exit:0",
      ]);
    }),
  );

  it.live("forces exit when the log flush exceeds its deadline", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const previousListeners = new Set(process.listeners(TEST_SIGNAL));
      const harness = makeHarness(false);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle;
          yield* lifecycle.register;
          findInstalledSignalListener(previousListeners)(TEST_SIGNAL);

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
          expect(harness.events).toEqual([
            "error:Lucent quit timed out; forcing exit",
            "flush",
          ]);

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(249));
          expect(harness.events).not.toContain("exit:0");

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          yield* Effect.promise(() => harness.exited);
        }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.events).toEqual([
        "error:Lucent quit timed out; forcing exit",
        "flush",
        "exit:0",
      ]);
    }),
  );
});
