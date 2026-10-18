import { EventEmitter } from "node:events";
import { app } from "electron";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../shared/logRecord";
import { makeLifetime } from "../window/RendererLifetimeTesting";
import { makeListenerRegistry } from "./ListenerRegistry";
import { installDesktopRendererObservability } from "./observability/DesktopRendererObservability";
import type {
  DesktopWindows,
  DesktopRendererEvent,
} from "../window/DesktopWindows";

import {
  makeDesktopGameRendererRecovery,
  type RecoverableGameWebContents,
} from "./DesktopGameRendererRecovery";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), webContents: {} };
});

const RENDERER_ID = 7;
const RELOAD = 0;
const DECLINE = 1;

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 4 }));

const makeHarness = (
  options: {
    readonly holdSuppression?: boolean;
    readonly suppressionFailure?: Error;
    readonly promptFailure?: Effect.Effect<never, unknown>;
    readonly observeRenderer?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const events = new EventEmitter();
    const timeline: string[] = [];
    const records: DesktopLogRecord[] = [];
    const causes: { name: string; message: string }[][] = [];
    const answers: ((response: number) => void)[] = [];
    const promptSignals: AbortSignal[] = [];
    const suppressions: Deferred.Deferred<void>[] = [];
    let generation = 1;
    const parentScope = yield* Effect.scope;
    const lifecycle = makeListenerRegistry<DesktopRendererEvent>();
    let current = makeLifetime(RENDERER_ID, 1, Scope.forkUnsafe(parentScope));
    const observe: DesktopWindows["Service"]["observe"] = (_filter, listener) =>
      lifecycle.subscribe(listener);
    const commit = Effect.gen(function* () {
      const old = current;
      generation += 1;
      current = makeLifetime(
        RENDERER_ID,
        generation,
        Scope.forkUnsafe(parentScope),
      );
      yield* Scope.close(old.scope, Exit.void);
      events.emit("did-navigate");
      yield* lifecycle.publish(
        { type: "reloaded", rendererId: RENDERER_ID, kind: "game", generation },
        "unbounded",
      );
    });
    let processShared = false;
    let destroyed = false;
    let beforeQuit: (() => void) | undefined;

    const contents = Object.assign(events, {
      id: RENDERER_ID,
      forcefullyCrashRenderer: () => {
        timeline.push(`crash generation ${generation}`);
      },
      getOSProcessId: () => 4242,
      isDestroyed: () => destroyed,
      reload: () => {
        timeline.push(`reload generation ${generation}`);
      },
    }) as unknown as RecoverableGameWebContents;

    const sharer = {
      id: RENDERER_ID + 1,
      getOSProcessId: () => 4242,
      isDestroyed: () => false,
    } as unknown as RecoverableGameWebContents;

    const prompt = (title: string) => () =>
      options.promptFailure ??
      Effect.promise((signal) => {
        const answer = Promise.withResolvers<number>();
        timeline.push(`${title} prompt for generation ${generation}`);
        answers.push(answer.resolve);
        promptSignals.push(signal);
        signal.addEventListener("abort", () => answer.resolve(DECLINE), {
          once: true,
        });
        return answer.promise;
      });

    const recovery = makeDesktopGameRendererRecovery({
      allWebContents: () => (processShared ? [contents, sharer] : [contents]),
      describe: (rendererId) =>
        Effect.sync(() =>
          rendererId === RENDERER_ID
            ? {
                rendererId,
                kind: "game" as const,
                windowId: 3,
                ownerId: undefined,
                generation,
                ready: true,
              }
            : undefined,
        ),
      lifetime: () => Effect.sync(() => current),
      observe,
      onWebContentsCreated: () => () => undefined,
      onBeforeQuit: (listener) => {
        beforeQuit = listener;
        return () => {
          beforeQuit = undefined;
        };
      },
      showRecoveryPrompt: prompt("unresponsive"),
      showRendererRecoveryPrompt: prompt("crash"),
      suppressLaunchScript: () =>
        Effect.gen(function* () {
          timeline.push("suppress");
          if (options.suppressionFailure !== undefined)
            return yield* Effect.fail(options.suppressionFailure);
          if (options.holdSuppression !== true) return;
          const release = yield* Deferred.make<void>();
          suppressions.push(release);
          yield* Deferred.await(release);
        }),
    });

    const installation = yield* Scope.fork(parentScope);
    yield* Effect.gen(function* () {
      if (options.observeRenderer) yield* installDesktopRendererObservability;
      yield* recovery.install;
    }).pipe(
      Scope.provide(installation),
      Effect.provide(
        Logger.layer(
          [
            Logger.make((options) => {
              records.push(desktopLogRecord(options));
              causes.push(
                Cause.prettyErrors(options.cause).map((error) => ({
                  name: error.name,
                  message: error.message,
                })),
              );
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );

    return {
      closeInstallation: Scope.close(installation, Exit.void),
      timeline,
      promptSignals,
      records,
      causes,
      answer: (index: number, response: number) =>
        Effect.sync(() => answers[index]!(response)).pipe(
          Effect.andThen(settle),
        ),
      releaseSuppression: (index: number) =>
        Deferred.succeed(suppressions[index]!, undefined).pipe(
          Effect.andThen(settle),
        ),
      startScript: Effect.suspend(() => recovery.beginScriptExecution(current)),
      finishScript: Effect.suspend(() =>
        recovery.finishScriptExecution(current),
      ),
      responsive: Effect.sync(() => {
        events.emit("responsive");
      }),
      destroy: Effect.sync(() => {
        destroyed = true;
        events.emit("destroyed");
      }),
      close: Effect.gen(function* () {
        yield* Scope.close(current.scope, Exit.void);
        yield* lifecycle.publish(
          {
            type: "closed",
            rendererId: RENDERER_ID,
            kind: "game",
            generation,
          },
          "unbounded",
        );
      }),
      quit: Effect.sync(() => beforeQuit?.()),
      hang: Effect.sync(() => {
        events.emit("responsive");
        events.emit("unresponsive");
      }).pipe(Effect.andThen(settle)),
      crash: Effect.gen(function* () {
        if (options.observeRenderer) {
          app.emit("render-process-gone", {}, contents, {
            reason: "crashed",
            exitCode: 1,
          });
        }
        const cleanup = Scope.closeUnsafe(current.scope, Exit.void);
        if (cleanup !== undefined)
          yield* cleanup.pipe(
            Effect.uninterruptible,
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* lifecycle.publish(
          {
            type: "crashed",
            rendererId: RENDERER_ID,
            kind: "game",
            generation,
            reason: "crashed",
          },
          "unbounded",
        );
      }).pipe(Effect.andThen(settle)),
      navigate: Effect.sync(() => {
        events.emit("did-start-loading");
      }).pipe(Effect.andThen(commit)),
      navigateWhileLoading: commit,
      navigateSameDocument: Effect.sync(() => {
        events.emit("did-start-loading");
      }),
      shareProcess: (shared: boolean) =>
        Effect.sync(() => {
          processShared = shared;
        }),
    };
  });

describe("makeDesktopGameRendererRecovery", () => {
  it.effect("logs the refusal to recover a shared renderer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.shareProcess(true);
      yield* harness.hang;
      expect(harness.records).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "warn",
          component: "game-renderer-recovery",
          message:
            "Refused to recover an unresponsive game renderer because its process is shared",
          data: { rendererId: 7 },
        },
      ]);
    }),
  );

  it.effect("logs successful unresponsive recovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.answer(0, RELOAD);
      expect(harness.records).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "game-renderer-recovery",
          message: "Recovered an unresponsive game renderer",
          data: { rendererId: 7 },
        },
      ]);
    }),
  );

  it.effect("logs one crash occurrence and its successful recovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ observeRenderer: true });
      yield* harness.crash;
      yield* harness.answer(0, RELOAD);
      expect(harness.records).toEqual([
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "error",
          component: "renderer",
          message: "Renderer process gone",
          repeatKey: "7:crashed",
          data: { reason: "crashed", rendererId: 7, exitCode: 1 },
        },
        {
          at: "1970-01-01T00:00:00.000Z",
          level: "info",
          component: "game-renderer-recovery",
          message: "Recovered a crashed game renderer",
          data: { reason: "crashed", rendererId: 7 },
        },
      ]);
    }),
  );

  it.effect.each([false, true])(
    "keeps a script suppression Cause during crash recovery %s",
    (crashed) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          suppressionFailure: new Error("suppression unavailable"),
        });
        yield* harness.startScript;
        yield* crashed ? harness.crash : harness.hang;
        yield* harness.answer(0, RELOAD);
        expect(
          harness.records.filter((record) => record.level === "error"),
        ).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "error",
            component: "game-renderer-recovery",
            message: crashed
              ? "Failed to suppress a script before renderer crash recovery"
              : "Failed to suppress a script before renderer recovery",
            data: { rendererId: 7 },
            error: [
              {
                name: "Error",
                message: "suppression unavailable",
                stack: expect.any(String),
              },
            ],
          },
        ]);
        expect(harness.causes).toEqual([
          [{ name: "Error", message: "suppression unavailable" }],
          [],
        ]);
      }),
  );

  it.effect.each([false, true])(
    "keeps the Cause when offering recovery fails with a defect %s",
    (defect) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          promptFailure: (defect ? Effect.die : Effect.fail)(
            new Error("dialog unavailable"),
          ),
        });
        yield* harness.startScript;
        yield* harness.hang;
        expect(harness.records).toEqual([
          {
            at: "1970-01-01T00:00:00.000Z",
            level: "error",
            component: "game-renderer-recovery",
            message: "Failed to offer renderer recovery",
            data: { rendererId: 7 },
            error: [
              {
                name: "Error",
                message: "dialog unavailable",
                stack: expect.any(String),
              },
            ],
          },
        ]);
        expect(harness.causes).toEqual([
          [{ name: "Error", message: "dialog unavailable" }],
        ]);
      }),
  );

  it.effect(
    "does not crash a newer generation when an older unresponsive dialog is accepted",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.navigate;
        yield* harness.startScript;
        yield* harness.hang;

        expect(harness.promptSignals.map((signal) => signal.aborted)).toEqual([
          true,
          false,
        ]);
        yield* harness.answer(0, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
        ]);

        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
          "suppress",
          "crash generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "keeps a newer unresponsive dialog pending when an older one closes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.navigate;
        yield* harness.startScript;
        yield* harness.hang;

        yield* harness.answer(0, DECLINE);
        yield* harness.hang;

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
        ]);

        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
          "suppress",
          "crash generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "opens one crash dialog per generation when an older crash dialog is accepted",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.crash;
        yield* harness.navigate;
        yield* harness.crash;

        expect(harness.promptSignals.map((signal) => signal.aborted)).toEqual([
          true,
          false,
        ]);
        yield* harness.answer(0, RELOAD);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "crash prompt for generation 2",
        ]);

        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "crash prompt for generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "does not crash a generation that loaded while the hung script was being suppressed",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holdSuppression: true });
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.answer(0, RELOAD);
        yield* harness.navigate;

        yield* harness.releaseSuppression(0);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "suppress",
        ]);

        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.answer(1, RELOAD);
        yield* harness.releaseSuppression(1);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "suppress",
          "unresponsive prompt for generation 2",
          "suppress",
          "crash generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "does not reload a generation that loaded while the crashed script was being suppressed",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holdSuppression: true });
        yield* harness.startScript;
        yield* harness.crash;
        yield* harness.answer(0, RELOAD);
        yield* harness.navigate;

        yield* harness.releaseSuppression(0);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "suppress",
        ]);

        yield* harness.crash;
        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "suppress",
          "crash prompt for generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "does not crash a renderer that navigated without a did-start-loading event",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.navigateWhileLoading;

        yield* settle;
        expect(harness.promptSignals[0]!.aborted).toBe(true);
        yield* harness.answer(0, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
        ]);

        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
          "suppress",
          "crash generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "offers recovery to a newer generation while a dialog from a navigation without did-start-loading is open",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.navigateWhileLoading;
        yield* harness.startScript;
        yield* harness.hang;

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
        ]);

        yield* harness.answer(0, RELOAD);
        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 2",
          "suppress",
          "crash generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect("keeps the same prompt through same-document loading", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.navigateSameDocument;
      yield* harness.hang;
      expect(harness.promptSignals[0]!.aborted).toBe(false);
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
      ]);
      yield* harness.answer(0, RELOAD);
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
        "suppress",
        "crash generation 1",
        "reload generation 1",
      ]);
    }),
  );

  it.effect(
    "does not suppress or crash a renderer whose process became shared while its prompt was open",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.shareProcess(true);
        yield* harness.answer(0, RELOAD);
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
        ]);
        yield* harness.shareProcess(false);
        yield* harness.hang;
        yield* harness.answer(1, RELOAD);
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 1",
          "suppress",
          "crash generation 1",
          "reload generation 1",
        ]);
      }),
  );

  it.effect(
    "does not crash a renderer whose process became shared while the hung script was being suppressed",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ holdSuppression: true });
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.answer(0, RELOAD);
        yield* harness.shareProcess(true);

        yield* harness.releaseSuppression(0);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "suppress",
        ]);

        yield* harness.shareProcess(false);
        yield* harness.hang;
        yield* harness.answer(1, RELOAD);
        yield* harness.releaseSuppression(1);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "suppress",
          "unresponsive prompt for generation 1",
          "suppress",
          "crash generation 1",
          "reload generation 1",
        ]);
      }),
  );

  it.effect.each([DECLINE, RELOAD])(
    "offers crash recovery when the open hang dialog answers %s",
    (answer) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.crash;
        expect(harness.promptSignals.map((signal) => signal.aborted)).toEqual([
          true,
          false,
        ]);
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
        ]);
        yield* harness.answer(0, answer);
        yield* harness.crash;
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
        ]);
        yield* harness.answer(1, RELOAD);
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
          "suppress",
          "reload generation 1",
        ]);
      }),
  );

  it.effect("does not reload a closed renderer after crash suppression", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ holdSuppression: true });
      yield* harness.startScript;
      yield* harness.crash;
      yield* harness.answer(0, RELOAD);
      yield* harness.destroy;
      yield* harness.releaseSuppression(0);
      expect(harness.timeline).toEqual([
        "crash prompt for generation 1",
        "suppress",
      ]);
    }),
  );

  it.effect(
    "reloads a newer generation's crash after an older crash dialog is declined",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.crash;
        yield* harness.navigateWhileLoading;
        yield* harness.crash;

        expect(harness.promptSignals.map((signal) => signal.aborted)).toEqual([
          true,
          false,
        ]);
        yield* harness.answer(0, DECLINE);
        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "crash prompt for generation 2",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "suppresses the script of a newer generation's crash after an older crash without one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.crash;
        yield* harness.navigateWhileLoading;
        yield* harness.startScript;
        yield* harness.crash;

        expect(harness.promptSignals.map((signal) => signal.aborted)).toEqual([
          true,
          false,
        ]);
        yield* harness.answer(1, RELOAD);

        expect(harness.timeline).toEqual([
          "crash prompt for generation 1",
          "crash prompt for generation 2",
          "suppress",
          "reload generation 2",
        ]);
      }),
  );

  it.effect(
    "does not offer an older generation's crash to a generation that loaded behind a hang dialog",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.crash;
        yield* harness.navigateWhileLoading;

        yield* harness.answer(0, DECLINE);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
        ]);
        yield* harness.answer(1, RELOAD);

        yield* harness.crash;

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
          "crash prompt for generation 2",
        ]);
      }),
  );

  it.effect("keeps script execution through bare loading", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.navigateSameDocument;
      yield* harness.hang;
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
      ]);
      yield* harness.answer(0, DECLINE);
    }),
  );

  it.effect(
    "does not carry script execution into a commit without loading",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.navigateWhileLoading;
        yield* harness.hang;
        expect(harness.timeline).toEqual([]);
        yield* harness.startScript;
        yield* harness.hang;
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 2",
        ]);
        yield* harness.answer(0, DECLINE);
      }),
  );
  it.effect("counts overlapping script executions until both finish", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.startScript;
      yield* harness.finishScript;
      yield* harness.hang;
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
      ]);
      yield* harness.answer(0, DECLINE);
      yield* harness.finishScript;
      yield* harness.hang;
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
      ]);
    }),
  );

  it.effect("keeps one prompt open for repeated hangs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.hang;
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
      ]);
      yield* harness.answer(0, DECLINE);
      yield* harness.hang;
      expect(harness.timeline).toEqual([
        "unresponsive prompt for generation 1",
        "unresponsive prompt for generation 1",
      ]);
      yield* harness.answer(1, DECLINE);
    }),
  );

  it.effect(
    "honors Reload after the renderer responds and its script finishes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.responsive;
        yield* harness.finishScript;
        yield* harness.answer(0, RELOAD);
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "suppress",
          "crash generation 1",
          "reload generation 1",
        ]);
      }),
  );

  it.effect.each(["destroy", "quit", "closeInstallation"] as const)(
    "does not recover a renderer after %s",
    (action) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness[action];
        yield* harness.answer(0, RELOAD);
        yield* harness.hang;
        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
        ]);
      }),
  );

  it.effect.each([
    { prompt: "hang", action: "close" },
    { prompt: "crash", action: "close" },
    { prompt: "hang", action: "destroy" },
    { prompt: "crash", action: "destroy" },
  ] as const)("dismisses the $prompt dialog on $action", ({ prompt, action }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.startScript;
      yield* harness[prompt];
      expect(harness.promptSignals[0]!.aborted).toBe(false);

      yield* harness[action];
      yield* settle;

      expect(harness.promptSignals[0]!.aborted).toBe(true);
      yield* harness.answer(0, RELOAD);
      expect(harness.timeline).toEqual(
        prompt === "hang"
          ? ["unresponsive prompt for generation 1"]
          : ["crash prompt for generation 1"],
      );
    }),
  );
});
