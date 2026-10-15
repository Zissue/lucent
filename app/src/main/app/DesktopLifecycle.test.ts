import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";

import {
  ElectronApp,
  type ElectronWillQuitEvent,
} from "../electron/ElectronApp";
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
  const appEvents = new EventEmitter();
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
    on: (eventName, listener) =>
      Effect.sync(() => {
        appEvents.on(eventName, listener);
        return () => {
          appEvents.removeListener(eventName, listener);
        };
      }),
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

  const emitWillQuit = (): void => {
    let defaultPrevented = false;
    const event: ElectronWillQuitEvent = {
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    appEvents.emit("will-quit", event);
    if (!defaultPrevented) {
      events.push("electron-terminated");
    }
  };

  const emitBeforeQuit = () => {
    appEvents.emit("before-quit");
  };

  return {
    emitBeforeQuit,
    emitWillQuit,
    events,
    exited: exited.promise,
    layer,
  };
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
  it.effect("marks quit on before-quit", () => {
    const harness = makeHarness(true);
    return Effect.gen(function* () {
      const lifecycle = yield* DesktopLifecycle;
      yield* lifecycle.register;
      yield* lifecycle.attachObservability;
      expect(yield* lifecycle.isQuitting).toBe(false);
      harness.emitBeforeQuit();
      expect(yield* lifecycle.isQuitting).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("keeps the process alive until cleanup after quit finishes", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const harness = makeHarness(true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle;
          yield* lifecycle.register;
          yield* lifecycle.attachObservability;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              harness.events.push("cleanup");
            }),
          );
          harness.emitWillQuit();
          yield* lifecycle.awaitQuit;
        }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.events).toEqual(["cleanup"]);
    }),
  );

  it.live("forces exit when cleanup after quit outlasts the deadline", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const harness = makeHarness(true);
      const registered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();

      const runtime = yield* Effect.forkDetach(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle;
            yield* lifecycle.register;
            yield* lifecycle.attachObservability;
            yield* Effect.addFinalizer(() => Deferred.await(releaseCleanup));
            yield* Deferred.succeed(registered, undefined);
            yield* lifecycle.awaitQuit;
          }).pipe(Effect.provide(harness.layer)),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(registered);
        harness.emitWillQuit();

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_500));
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(harness.events).toEqual([
              "error:Lucent quit timed out; forcing exit",
              "flush",
              "exit:0",
            ]);
          }),
        );
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseCleanup, undefined).pipe(
            Effect.andThen(Fiber.await(runtime)),
          ),
        ),
      );
    }),
  );

  it.live("flushes the timeout diagnostic before forcing exit", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const previousListeners = new Set(process.listeners(TEST_SIGNAL));
      const harness = makeHarness(true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle;
          yield* lifecycle.register;
          yield* lifecycle.attachObservability;
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
          yield* lifecycle.attachObservability;
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

  it.live("keeps its signal listener installed after the first signal", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const previousListeners = new Set(process.rawListeners(TEST_SIGNAL));
      const harness = makeHarness(true);

      const stillInstalled = yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle;
          yield* lifecycle.register;
          yield* lifecycle.attachObservability;
          const installed = process
            .rawListeners(TEST_SIGNAL)
            .find((candidate) => !previousListeners.has(candidate));
          if (installed === undefined) {
            throw new Error(`Expected a ${TEST_SIGNAL} listener`);
          }
          installed.call(process, TEST_SIGNAL);
          return process.rawListeners(TEST_SIGNAL).includes(installed);
        }).pipe(Effect.provide(harness.layer)),
      );

      expect(stillInstalled).toBe(true);
    }),
  );

  it.live("keeps the first deadline when will-quit follows a signal", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const previousListeners = new Set(process.listeners(TEST_SIGNAL));
      const harness = makeHarness(true);
      const registered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();

      const runtime = yield* Effect.forkDetach(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle;
            yield* lifecycle.register;
            yield* lifecycle.attachObservability;
            yield* Effect.addFinalizer(() => Deferred.await(releaseCleanup));
            yield* Deferred.succeed(registered, undefined);
            yield* lifecycle.awaitQuit;
          }).pipe(Effect.provide(harness.layer)),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Deferred.await(registered);
        findInstalledSignalListener(previousListeners)(TEST_SIGNAL);

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
        harness.emitWillQuit();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(499));
        expect(harness.events).toEqual([]);

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(harness.events).toEqual([
              "error:Lucent quit timed out; forcing exit",
              "flush",
              "exit:0",
            ]);
          }),
        );
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseCleanup, undefined).pipe(
            Effect.andThen(Fiber.await(runtime)),
          ),
        ),
      );
    }),
  );
});
