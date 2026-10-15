import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeListenerRegistry } from "./ListenerRegistry";
import type {
  DesktopWindows,
  DesktopRendererEvent,
  RendererLifetime,
} from "../window/DesktopWindows";

import {
  makeDesktopGameRendererRecovery,
  type RecoverableGameWebContents,
} from "./DesktopGameRendererRecovery";

vi.mock("electron", () => ({ app: {}, webContents: {} }));

const RENDERER_ID = 7;
const RELOAD = 0;
const DECLINE = 1;

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 4 }));

const makeHarness = (
  options: {
    readonly holdSuppression?: boolean;
    readonly holdPromptCleanup?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const events = new EventEmitter();
    const timeline: string[] = [];
    const answers: ((response: number) => void)[] = [];
    const signals: AbortSignal[] = [];
    const suppressions: Deferred.Deferred<void>[] = [];
    const cleanupRelease = yield* Deferred.make<void>();
    let generation = 1;
    const parentScope = yield* Effect.scope;
    const lifecycle = makeListenerRegistry<DesktopRendererEvent>();
    const makeLifetime = (generation: number) => {
      const scope = Scope.forkUnsafe(parentScope);
      const lifetime: RendererLifetime & { readonly scope: Scope.Closeable } = {
        rendererId: RENDERER_ID,
        generation,
        scope,
        isCurrent: () => current === lifetime && scope.state._tag !== "Closed",
      };
      return lifetime;
    };
    let current = makeLifetime(1);
    const observe: DesktopWindows["Service"]["observe"] = (_filter, listener) =>
      Effect.acquireRelease(lifecycle.subscribe(listener), (unsubscribe) =>
        Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid);
    const commit = Effect.gen(function* () {
      const old = current;
      generation += 1;
      current = makeLifetime(generation);
      yield* Scope.close(old.scope, Exit.void);
      events.emit("did-navigate");
      yield* lifecycle.publish(
        { type: "reloaded", rendererId: RENDERER_ID, kind: "game", generation },
        "unbounded",
      );
    });
    let processShared = false;

    const contents = Object.assign(events, {
      id: RENDERER_ID,
      forcefullyCrashRenderer: () => {
        timeline.push(`crash generation ${generation}`);
      },
      getOSProcessId: () => 4242,
      isDestroyed: () => false,
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
      Effect.promise((signal) => {
        const answer = Promise.withResolvers<number>();
        timeline.push(`${title} prompt for generation ${generation}`);
        answers.push(answer.resolve);
        signals.push(signal);
        signal.addEventListener("abort", () => answer.resolve(DECLINE), {
          once: true,
        });
        return answer.promise;
      }).pipe(
        Effect.ensuring(
          options.holdPromptCleanup === true
            ? Deferred.await(cleanupRelease)
            : Effect.void,
        ),
      );

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
      onBeforeQuit: () => () => undefined,
      showRecoveryPrompt: prompt("unresponsive"),
      showRendererRecoveryPrompt: prompt("crash"),
      suppressLaunchScript: () =>
        Effect.gen(function* () {
          timeline.push("suppress");
          if (options.holdSuppression !== true) return;
          const release = yield* Deferred.make<void>();
          suppressions.push(release);
          yield* Deferred.await(release);
        }),
      warn: () => Effect.void,
      error: (message) =>
        Effect.sync(() => {
          timeline.push(`error: ${message}`);
        }),
      info: () => Effect.void,
    });

    const installation = yield* Scope.fork(parentScope);
    yield* recovery.install.pipe(Scope.provide(installation));

    return {
      closeInstallation: Scope.close(installation, Exit.void),
      timeline,
      signals,
      releasePromptCleanup: Deferred.succeed(cleanupRelease, undefined).pipe(
        Effect.andThen(settle),
      ),
      commitBeforeLifecycleDelivery: Effect.gen(function* () {
        const old = current;
        generation += 1;
        current = makeLifetime(generation);
        yield* Scope.close(old.scope, Exit.void);
      }),
      answer: (index: number, response: number) =>
        Effect.sync(() => answers[index]!(response)).pipe(
          Effect.andThen(settle),
        ),
      releaseSuppression: (index: number) =>
        Deferred.succeed(suppressions[index]!, undefined).pipe(
          Effect.andThen(settle),
        ),
      startScript: Effect.suspend(() => recovery.beginScriptExecution(current)),
      hang: Effect.sync(() => {
        events.emit("responsive");
        events.emit("unresponsive");
      }).pipe(Effect.andThen(settle)),
      crash: Effect.gen(function* () {
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

  it.effect(
    "interrupts an open unresponsive dialog before offering crash recovery",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.crash;

        expect(harness.signals[0]?.aborted).toBe(true);

        yield* harness.answer(0, DECLINE);

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

  it.effect(
    "reloads a newer generation's crash after an older crash dialog is declined",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.crash;
        yield* harness.navigateWhileLoading;
        yield* harness.crash;

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

        yield* harness.crash;

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "crash prompt for generation 1",
          "crash prompt for generation 2",
        ]);
      }),
  );
});

it.effect("keeps script execution through bare loading", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.startScript;
    yield* harness.navigateSameDocument;
    yield* harness.hang;
    expect(harness.timeline).toEqual(["unresponsive prompt for generation 1"]);
    yield* harness.answer(0, DECLINE);
  }),
);

it.effect("does not carry script execution into a commit without loading", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.startScript;
    yield* harness.navigateWhileLoading;
    yield* harness.hang;
    expect(harness.timeline).toEqual([]);
    yield* harness.startScript;
    yield* harness.hang;
    expect(harness.timeline).toEqual(["unresponsive prompt for generation 2"]);
    yield* harness.answer(0, DECLINE);
  }),
);

it.effect("aborts an open prompt when its document commits a replacement", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.startScript;
    yield* harness.hang;
    expect(harness.signals[0]?.aborted).toBe(false);
    yield* harness.navigateWhileLoading;
    yield* settle;
    expect(harness.signals[0]?.aborted).toBe(true);
    yield* harness.answer(0, RELOAD);
    expect(harness.timeline).toEqual(["unresponsive prompt for generation 1"]);
  }),
);

it.effect(
  "keeps one new attempt while an old crash prompt is still cleaning up",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ holdPromptCleanup: true });
      yield* harness.crash;
      yield* harness.commitBeforeLifecycleDelivery;
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.hang;
      yield* harness.releasePromptCleanup;
      expect(harness.timeline).toEqual([
        "crash prompt for generation 1",
        "unresponsive prompt for generation 2",
      ]);
      yield* harness.answer(1, RELOAD);
      expect(harness.timeline).toEqual([
        "crash prompt for generation 1",
        "unresponsive prompt for generation 2",
        "suppress",
        "crash generation 2",
        "reload generation 2",
      ]);
    }),
);

it.effect("aborts a crash prompt on the next commit", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.crash;
    expect(harness.signals[0]?.aborted).toBe(false);
    yield* harness.navigateWhileLoading;
    yield* settle;
    expect(harness.signals[0]?.aborted).toBe(true);
    yield* harness.answer(0, RELOAD);
    expect(harness.timeline).toEqual(["crash prompt for generation 1"]);
  }),
);

it.effect(
  "offers crash recovery while the interrupted hang prompt finishes cleanup",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ holdPromptCleanup: true });
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.crash;
      expect(harness.signals[0]?.aborted).toBe(true);
      const offered = [...harness.timeline];
      yield* harness.releasePromptCleanup;
      expect(offered).toEqual([
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

it.effect(
  "waits for prompt cleanup already interrupted by a crash during shutdown",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ holdPromptCleanup: true });
      yield* harness.startScript;
      yield* harness.hang;
      yield* harness.crash;
      let closed = false;
      const closing = yield* harness.closeInstallation.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* settle;
      expect(closed).toBe(false);
      expect(harness.signals.map((signal) => signal.aborted)).toEqual([
        true,
        true,
      ]);
      yield* harness.releasePromptCleanup;
      yield* Fiber.join(closing);
      expect(closed).toBe(true);
    }),
);
