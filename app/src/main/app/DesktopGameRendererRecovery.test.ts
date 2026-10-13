import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  makeDesktopGameRendererRecovery,
  type RecoverableGameWebContents,
} from "./DesktopGameRendererRecovery";

vi.mock("electron", () => ({ app: {}, webContents: {} }));

const RENDERER_ID = 7;
const RELOAD = 0;
const DECLINE = 1;

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 4 }));

const makeHarness = (options: { readonly holdSuppression?: boolean } = {}) =>
  Effect.gen(function* () {
    const events = new EventEmitter();
    const timeline: string[] = [];
    const answers: Deferred.Deferred<number>[] = [];
    const suppressions: Deferred.Deferred<void>[] = [];
    let generation = 1;
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
      Effect.gen(function* () {
        const answer = yield* Deferred.make<number>();
        timeline.push(`${title} prompt for generation ${generation}`);
        answers.push(answer);
        return yield* Deferred.await(answer);
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

    yield* recovery.install;

    return {
      timeline,
      answer: (index: number, response: number) =>
        Deferred.succeed(answers[index]!, response).pipe(
          Effect.andThen(settle),
        ),
      releaseSuppression: (index: number) =>
        Deferred.succeed(suppressions[index]!, undefined).pipe(
          Effect.andThen(settle),
        ),
      startScript: recovery.beginScriptExecution(RENDERER_ID),
      hang: Effect.sync(() => {
        events.emit("responsive");
        events.emit("unresponsive");
      }).pipe(Effect.andThen(settle)),
      crash: Effect.sync(() => {
        events.emit(
          "render-process-gone",
          {},
          { reason: "crashed", exitCode: 1 },
        );
      }).pipe(Effect.andThen(settle)),
      navigate: Effect.sync(() => {
        events.emit("did-start-loading");
        generation += 1;
      }),
      navigateWhileLoading: Effect.sync(() => {
        generation += 1;
      }),
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

  it.effect(
    "does not act on a dialog superseded by a same-document navigation",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.startScript;
        yield* harness.hang;
        yield* harness.navigateSameDocument;
        yield* harness.startScript;
        yield* harness.hang;

        yield* harness.answer(0, RELOAD);

        expect(harness.timeline).toEqual([
          "unresponsive prompt for generation 1",
          "unresponsive prompt for generation 1",
        ]);

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
});
