import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";

import { DEFAULT_APP_SETTINGS } from "@lucent/core/settings";
import { DesktopWindowKindSchema } from "../../shared/ipc/windows";
import { layer as desktopEnvironmentLayer } from "../app/DesktopEnvironment";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronSession } from "../electron/ElectronSession";
import { ElectronShell } from "../electron/ElectronShell";
import { ElectronTheme } from "../electron/ElectronTheme";
import {
  ElectronWindow,
  ElectronWindowLoadError,
  type ElectronWindowHandle,
  type ElectronGameViewHandle,
  type ElectronNativeWindowHandle,
} from "../electron/ElectronWindow";
import { RuffleSocketProxy } from "../ruffle/RuffleSocketProxy";
import { makeDesktopIpcSenders } from "../ipc/DesktopIpcSenders";
import { DesktopSettings } from "../settings/DesktopSettings";
import {
  getDesktopWindowDefinition,
  type DesktopWindowKind,
} from "./DesktopWindowCatalog";
import {
  DesktopWindows,
  layer as desktopWindowsLayer,
  type DesktopRendererEvent,
  type DesktopRendererInfo,
  type DesktopWindowOpenOptions,
} from "./DesktopWindows";

vi.mock("electron", () => ({}));

const singleInstanceKinds = DesktopWindowKindSchema.literals.filter(
  (kind) => getDesktopWindowDefinition(kind).singleInstance,
);

const makeWindow = (id: number) =>
  Object.assign(new EventEmitter(), {
    id,
    hide: () => {},
    isDestroyed: () => false,
    isFocused: () => false,
    setTitle: () => {},
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 830 }),
    webContents: Object.assign(new EventEmitter(), {
      id,
      focus: () => {},
      send: () => {},
      getZoomFactor: () => 1,
      isDestroyed: () => false,
    }),
  });

const makeHarness = (useGameTabs = false) => {
  let settingsRead: Effect.Effect<void> = Effect.void;
  let nextLoad: Effect.Effect<void, ElectronWindowLoadError> | undefined;
  let nextRendererId = 101;
  const created = new Map<number, ReturnType<typeof makeWindow>>();

  const windowService = ElectronWindow.of({
    create: () =>
      Effect.sync(() => {
        const window = makeWindow(nextRendererId++);
        created.set(window.id, window);
        return window as unknown as ElectronWindowHandle;
      }),
    createHost: () =>
      Effect.succeed(makeWindow(100) as unknown as ElectronNativeWindowHandle),
    createView: () =>
      Effect.sync(() => {
        const window = makeWindow(nextRendererId++);
        created.set(window.id, window);
        return {
          native: {},
          webContents: window.webContents,
          getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
          setBounds: () => {},
          setBackgroundColor: () => {},
        } as unknown as ElectronGameViewHandle;
      }),
    loadFile: () =>
      Effect.suspend(() => {
        const load = nextLoad ?? Effect.void;
        nextLoad = undefined;
        return load;
      }),
    reveal: () => Effect.void,
  });
  const dependencies = Layer.mergeAll(
    desktopEnvironmentLayer({
      appDataDir: "/tmp/lucent-app-data",
      assetsDir: "/tmp/lucent-assets",
      isDev: true,
      platform: "darwin",
      workspaceDir: "/tmp/lucent-workspace",
    }),
    Layer.succeed(
      DesktopSettings,
      DesktopSettings.of({
        get: Effect.suspend(() => settingsRead).pipe(
          Effect.as({
            ...DEFAULT_APP_SETTINGS,
            preferences: { ...DEFAULT_APP_SETTINGS.preferences, useGameTabs },
          }),
        ),
        load: Effect.succeed(DEFAULT_APP_SETTINGS),
        onChanged: () => Effect.succeed(() => undefined),
        resetAppearance: Effect.succeed(DEFAULT_APP_SETTINGS),
        resetHotkeys: Effect.succeed(DEFAULT_APP_SETTINGS),
        updateAppearance: () => Effect.succeed(DEFAULT_APP_SETTINGS),
        updateHotkeys: () => Effect.succeed(DEFAULT_APP_SETTINGS),
        updatePreferences: () => Effect.succeed(DEFAULT_APP_SETTINGS),
      }),
    ),
    Layer.succeed(
      ElectronApp,
      ElectronApp.of({
        exit: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        getVersion: Effect.succeed("0.0.0"),
        on: () => Effect.succeed(() => undefined),
        quit: Effect.void,
        relaunch: Effect.void,
        whenReady: Effect.void,
      }),
    ),
    Layer.succeed(
      ElectronSession,
      ElectronSession.of({
        acquireGamePartition: () => Effect.succeed("persist:game"),
        clearAppData: Effect.void,
        prepareGameNetworking: Effect.void,
        retireManagedGameProfile: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ElectronShell,
      ElectronShell.of({
        openExternal: () => Effect.succeed(true),
        openPath: () => Effect.succeed(true),
        showItemInFolder: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ElectronTheme,
      ElectronTheme.of({
        setThemeMode: () => Effect.void,
        shouldUseDarkColors: Effect.succeed(true),
      }),
    ),
    Layer.succeed(ElectronWindow, windowService),
    Layer.succeed(
      RuffleSocketProxy,
      RuffleSocketProxy.of({ getUrl: Effect.succeed("ws://127.0.0.1:1") }),
    ),
  );

  return {
    created,
    failNextLoadAfter: (gate: Effect.Effect<void>) => {
      nextLoad = gate.pipe(
        Effect.andThen(
          Effect.fail(
            new ElectronWindowLoadError({
              cause: "load failed",
              path: "index.html",
            }),
          ),
        ),
      );
    },
    holdSettings: Effect.gen(function* () {
      const heldSettings = yield* Latch.make(false);
      settingsRead = heldSettings.await;
      return heldSettings;
    }),
    layer: desktopWindowsLayer.pipe(Layer.provide(dependencies)),
  };
};

const ownerOptions = (kind: DesktopWindowKind) =>
  Effect.gen(function* () {
    if (getDesktopWindowDefinition(kind).scope !== "game-child") {
      return undefined;
    }
    const windows = yield* DesktopWindows;
    return { ownerRendererId: yield* windows.open("game") };
  });

const startOpen = (
  kind: DesktopWindowKind,
  options: DesktopWindowOpenOptions | undefined,
) =>
  DesktopWindows.use((windows) => windows.open(kind, options)).pipe(
    Effect.forkChild({ startImmediately: true }),
  );

describe("DesktopWindows.open", () => {
  it.effect.each(singleInstanceKinds)(
    "opens one %s window for concurrent requests",
    (kind) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const options = yield* ownerOptions(kind);
        const heldSettings = yield* harness.holdSettings;

        const first = yield* startOpen(kind, options);
        const second = yield* startOpen(kind, options);
        yield* heldSettings.open;

        const expectedId = options === undefined ? 101 : 102;
        expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([
          expectedId,
          expectedId,
        ]);
        expect(yield* windows.open(kind, options)).toBe(expectedId);
        expect(yield* windows.getRendererIds(kind)).toEqual([expectedId]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("opens one window per owner for concurrent child requests", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const windows = yield* DesktopWindows;
      const firstOwner = yield* windows.open("game");
      const secondOwner = yield* windows.open("game");
      const heldSettings = yield* harness.holdSettings;

      const first = yield* startOpen("packets", {
        ownerRendererId: firstOwner,
      });
      const second = yield* startOpen("packets", {
        ownerRendererId: secondOwner,
      });
      const repeat = yield* startOpen("packets", {
        ownerRendererId: firstOwner,
      });
      yield* heldSettings.open;

      expect([
        yield* Fiber.join(first),
        yield* Fiber.join(second),
        yield* Fiber.join(repeat),
      ]).toEqual([103, 104, 103]);
      expect(yield* windows.getOwnedRendererIds(firstOwner)).toEqual([103]);
      expect(yield* windows.getOwnedRendererIds(secondOwner)).toEqual([104]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "gives a concurrent request the same error when the pending open fails",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const loadStarted = yield* Latch.make(false);
        const loadFinished = yield* Latch.make(false);
        harness.failNextLoadAfter(
          loadStarted.open.pipe(Effect.andThen(loadFinished.await)),
        );

        const first = yield* startOpen("settings", undefined);
        yield* loadStarted.await;
        const second = yield* startOpen("settings", undefined);
        yield* loadFinished.open;

        const firstError = yield* Effect.flip(Fiber.join(first));
        expect(firstError.detail).toBe(
          "Failed to open desktop window: settings",
        );
        const secondOutcome = yield* Fiber.join(second).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: (rendererId) => rendererId,
          }),
        );
        expect(secondOutcome).toBe(firstError);
        expect(yield* windows.getRendererIds("settings")).toEqual([]);
        expect(yield* windows.open("settings")).toBe(102);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "interrupts a concurrent request when the pending open is interrupted",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const heldSettings = yield* harness.holdSettings;

        const first = yield* startOpen("settings", undefined);
        const second = yield* startOpen("settings", undefined);
        yield* Fiber.interrupt(first);
        yield* heldSettings.open;

        expect(Exit.hasInterrupts(yield* Fiber.await(second))).toBe(true);
        expect(yield* windows.getRendererIds("settings")).toEqual([]);
        expect(yield* windows.open("settings")).toBe(101);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "keeps the pending open when a concurrent request is interrupted",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const heldSettings = yield* harness.holdSettings;

        const first = yield* startOpen("settings", undefined);
        const second = yield* startOpen("settings", undefined);
        yield* Fiber.interrupt(second);
        yield* heldSettings.open;

        expect(yield* Fiber.join(first)).toBe(101);
        expect(yield* windows.getRendererIds("settings")).toEqual([101]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("opens a game window for each concurrent request", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const windows = yield* DesktopWindows;
      const heldSettings = yield* harness.holdSettings;

      const first = yield* startOpen("game", undefined);
      const second = yield* startOpen("game", undefined);
      yield* heldSettings.open;

      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([
        101, 102,
      ]);
      expect(yield* windows.getRendererIds("game")).toEqual([101, 102]);
    }).pipe(Effect.provide(harness.layer));
  });
});

const navigate = { isMainFrame: true, isSameDocument: false };
const liveInfo = (generation: number): DesktopRendererInfo => ({
  rendererId: 101,
  kind: "game",
  windowId: 101,
  ownerId: undefined,
  generation,
  ready: false,
});

const lifecycles = [
  {
    end: (window: ReturnType<typeof makeWindow>) => window.emit("closed"),
    expected: {
      event: { type: "closed", rendererId: 101, kind: "game" },
      current: false,
      next: false,
      info: undefined,
    },
  },
  {
    end: ({ webContents }: ReturnType<typeof makeWindow>) => {
      webContents.emit("did-navigate");
      webContents.emit("did-navigate");
    },
    expected: {
      event: { type: "reloaded", rendererId: 101, kind: "game", generation: 2 },
      current: false,
      next: true,
      info: liveInfo(2),
    },
  },
  {
    end: ({ webContents }: ReturnType<typeof makeWindow>) =>
      webContents.emit("render-process-gone", {}, { reason: "crashed" }),
    expected: {
      event: {
        type: "crashed",
        rendererId: 101,
        kind: "game",
        reason: "crashed",
      },
      current: false,
      next: false,
      info: liveInfo(1),
    },
  },
] as const;

describe("DesktopWindows renderer generations", () => {
  for (const { end, expected } of lifecycles) {
    it.effect(
      `invalidates the generation before publishing ${expected.event.type}`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const windows = yield* DesktopWindows;
          const rendererId = yield* windows.open("game");
          const isFirstGeneration = yield* windows.generationGuard(
            rendererId,
            1,
          );
          const isSecondGeneration = yield* windows.generationGuard(
            rendererId,
            2,
          );
          const observed = yield* Deferred.make<{
            readonly event: DesktopRendererEvent;
            readonly current: boolean;
            readonly next: boolean;
            readonly info: DesktopRendererInfo | undefined;
          }>();
          yield* windows.observe({ kind: "game" }, (event) =>
            Effect.gen(function* () {
              const current = isFirstGeneration();
              const next = isSecondGeneration();
              const info = yield* windows.describe(rendererId);
              yield* Deferred.succeed(observed, { event, current, next, info });
            }),
          );
          expect(rendererId).toBe(101);
          expect(isFirstGeneration()).toBe(true);

          end(harness.created.get(rendererId)!);

          expect(yield* Deferred.await(observed)).toEqual(expected);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }
});

describe("DesktopWindows document commits", () => {
  it.effect("keeps the ready generation when navigation is cancelled", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const windows = yield* DesktopWindows;
      const id = yield* windows.open("game");
      const contents = harness.created.get(id)!.webContents;
      contents.emit("did-start-navigation", navigate);
      contents.emit("did-navigate");
      yield* windows.markRendererReady(id, 1);
      const events: DesktopRendererEvent[] = [];
      yield* windows.observe({}, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      contents.emit("did-start-navigation", navigate);
      yield* Effect.yieldNow;
      expect(yield* windows.describe(id)).toEqual({
        ...liveInfo(1),
        ready: true,
      });
      expect(events).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a game view ready after bare loading", () => {
    const harness = makeHarness(true);
    return Effect.gen(function* () {
      const windows = yield* DesktopWindows;
      const id = yield* windows.open("game");
      yield* windows.markRendererReady(id, 1);
      harness.created.get(id)!.webContents.emit("did-start-loading");
      expect((yield* windows.describe(id))?.ready).toBe(true);
      expect((yield* windows.getGameViewHostState(102)).sessions).toEqual([
        { id: "103", name: "Tab 1", phase: "ready" },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "keeps a sender resolved during navigation current until commit",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const id = yield* windows.open("game");
        const contents = harness.created.get(id)!.webContents;
        contents.emit("did-start-navigation", navigate);
        contents.emit("did-navigate");
        contents.emit("did-start-navigation", navigate);
        const sender = yield* makeDesktopIpcSenders(windows).require(
          { sender: contents },
          ["game"],
        );
        expect(sender.isCurrent()).toBe(true);
        expect((yield* windows.describe(id))?.generation).toBe(1);
        contents.emit("did-navigate");
        expect(sender.isCurrent()).toBe(false);
        expect((yield* windows.describe(id))?.generation).toBe(2);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "replaces a generation that crashed before its first commit",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const id = yield* windows.open("game");
        const contents = harness.created.get(id)!.webContents;
        const first = yield* windows.generationGuard(id, 1);
        contents.emit("render-process-gone", {}, { reason: "crashed" });
        expect(first()).toBe(false);
        contents.emit("did-start-navigation", navigate);
        contents.emit("did-navigate");
        expect((yield* windows.describe(id))?.generation).toBe(2);
        expect((yield* windows.generationGuard(id, 2))()).toBe(true);
        yield* windows.markRendererReady(id, 2);
        expect((yield* windows.describe(id))?.ready).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps a game view ready after an aborted load", () => {
    const harness = makeHarness(true);
    return Effect.gen(function* () {
      const windows = yield* DesktopWindows;
      const id = yield* windows.open("game");
      const contents = harness.created.get(id)!.webContents;
      contents.emit("did-navigate");
      yield* windows.markRendererReady(id, 1);
      const events: DesktopRendererEvent[] = [];
      yield* windows.observe({}, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      contents.emit(
        "did-fail-load",
        {},
        -3,
        "ERR_ABORTED",
        "file:///game",
        true,
      );
      yield* Effect.yieldNow;
      expect((yield* windows.describe(id))?.generation).toBe(1);
      expect((yield* windows.describe(id))?.ready).toBe(true);
      expect((yield* windows.getGameViewHostState(102)).sessions).toEqual([
        { id: "103", name: "Tab 1", phase: "ready" },
      ]);
      expect(events).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "ignores committed subframe errors and uncommitted load failures",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const windows = yield* DesktopWindows;
        const id = yield* windows.open("game");
        const contents = harness.created.get(id)!.webContents;
        contents.emit("did-navigate");
        yield* windows.markRendererReady(id, 1);
        const events: DesktopRendererEvent[] = [];
        yield* windows.observe({}, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );
        contents.emit(
          "did-fail-provisional-load",
          {},
          -324,
          "ERR_EMPTY_RESPONSE",
          "file:///frame",
          false,
        );
        contents.emit(
          "did-fail-load",
          {},
          -2,
          "ERR_FAILED",
          "file:///game",
          true,
        );
        yield* Effect.yieldNow;
        expect(yield* windows.describe(id)).toEqual({
          ...liveInfo(1),
          ready: true,
        });
        expect(events).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  for (const code of [-324, -3]) {
    it.effect(
      `advances for a committed main-frame error page with code ${code}`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const windows = yield* DesktopWindows;
          const id = yield* windows.open("game");
          const contents = harness.created.get(id)!.webContents;
          contents.emit("did-navigate");
          yield* windows.markRendererReady(id, 1);
          const events: DesktopRendererEvent[] = [];
          yield* windows.observe({}, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          );
          contents.emit(
            "did-fail-provisional-load",
            {},
            code,
            "error",
            "file:///game",
            true,
          );
          contents.emit(
            "did-fail-load",
            {},
            code,
            "error",
            "file:///game",
            true,
          );
          yield* Effect.yieldNow;
          expect((yield* windows.describe(id))?.generation).toBe(2);
          expect((yield* windows.describe(id))?.ready).toBe(false);
          expect(events).toEqual([
            { type: "reloaded", rendererId: 101, kind: "game", generation: 2 },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }
});
