import {
  type Event as ElectronEvent,
  type RenderProcessGoneDetails,
} from "electron";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import appBranding from "../../../appBranding.json";
import {
  GAME_VIEW_TAB_BAR_HEIGHT,
  MAX_GAME_VIEWS_PER_WINDOW,
  type GameViewHostState,
  type GameViewLayout,
  type GameViewPresentation,
  type GameViewSelectionFocus,
} from "../../shared/gameViews";
import { GameViewsIpc } from "../../shared/ipc";
import {
  type AppearanceSnapshot,
  createAppearanceSnapshot,
} from "../../shared/appearance";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "@lucent/core/settings";
import { makeListenerRegistry } from "../app/ListenerRegistry";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { logFailure } from "../../shared/logFailure";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronSession } from "../game/session/GameSessions";
import { ElectronShell } from "../electron/ElectronShell";
import { ElectronTheme } from "../electron/ElectronTheme";
import {
  ElectronWindow,
  ElectronWindowLoadError,
  isElectronWindowUsable,
  type ElectronWindowHandle,
  type ElectronNativeWindowHandle,
} from "../electron/ElectronWindow";
import { RuffleSocketProxy } from "../game/session/RuffleSocketProxy";
import { DesktopSettings } from "../settings/DesktopSettings";
import {
  getDesktopWindowDefinition,
  type DesktopRendererKind,
  type DesktopWindowDefinition,
  type DesktopWindowKind,
} from "./DesktopWindowCatalog";
import {
  makeDesktopGameHosts,
  normalizeGameViewName,
  type DesktopGameHostRecord,
  type DesktopGameViewRecord,
} from "./DesktopGameHost";
import {
  viewHtmlPath,
  createRendererWebPreferences,
  createNativeWindowOptions,
  createWindowOptions,
  gamePartitionOwner,
  createGameViewOptions,
} from "./DesktopWindowOptions";
import { parseAllowedGameWindowOpenUrl } from "./GameWindowOpenPolicy";
import { formatGameWindowTitle } from "./GameWindowTitle";

export class DesktopWindowError extends Schema.TaggedError<DesktopWindowError>()(
  "DesktopWindowError",
  {
    id: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type GameViewHostChange =
  | {
      readonly type: "select";
      readonly id: number;
      readonly focus: GameViewSelectionFocus;
    }
  | { readonly type: "reorder"; readonly ids: readonly number[] }
  | { readonly type: "layout"; readonly layout: GameViewLayout }
  | { readonly type: "group-controls"; readonly open: boolean }
  | { readonly type: "tab-menu"; readonly open: boolean }
  | { readonly type: "group-targets"; readonly ids: readonly number[] }
  | { readonly type: "tab-bar-layout" };

export interface RendererLifetime {
  readonly rendererId: number;
  readonly generation: number;
  readonly scope: Scope.Scope;
  readonly isCurrent: () => boolean;
}

export interface CloseableRendererLifetime extends RendererLifetime {
  readonly scope: Scope.Closeable;
}

export interface DesktopRendererInfo {
  readonly rendererId: number;
  readonly kind: DesktopRendererKind;
  readonly windowId: number;
  readonly ownerId: number | undefined;
  readonly generation: number;
  readonly ready: boolean;
}

export type DesktopRendererIdentity = Pick<
  DesktopRendererInfo,
  "rendererId" | "kind"
> & {
  readonly lifetime: RendererLifetime;
};

export interface DesktopWindowsShape {
  readonly updateGameViewHost: (
    rendererId: number,
    change: GameViewHostChange,
  ) => Effect.Effect<GameViewHostState, DesktopWindowError>;
  readonly closeRenderer: (rendererId: number) => Effect.Effect<boolean>;
  readonly getRendererIds: (
    kind: DesktopWindowKind,
  ) => Effect.Effect<readonly number[]>;
  readonly describe: (
    rendererId: number,
  ) => Effect.Effect<DesktopRendererInfo | undefined>;
  readonly getVisibleParentWindowId: Effect.Effect<number | undefined>;
  readonly isVisibleParentWindow: (windowId: number) => Effect.Effect<boolean>;
  readonly identify: (
    rendererId: number,
  ) => Effect.Effect<DesktopRendererIdentity | undefined>;
  readonly lifetime: (
    rendererId: number,
  ) => Effect.Effect<RendererLifetime | undefined>;
  readonly getOwnedRendererIds: (
    ownerRendererId: number,
    kind?: DesktopWindowKind,
  ) => Effect.Effect<readonly number[], DesktopWindowError>;
  readonly markRendererReady: (
    lifetime: RendererLifetime,
  ) => Effect.Effect<void, DesktopWindowError>;
  readonly addGameView: (
    hostRendererId: number,
  ) => Effect.Effect<GameViewHostState, DesktopWindowError>;
  readonly closeGameView: (
    hostRendererId: number,
    id: number,
  ) => Effect.Effect<void, DesktopWindowError>;
  readonly getGameViewHostState: (
    hostRendererId: number,
  ) => Effect.Effect<GameViewHostState, DesktopWindowError>;
  readonly getGameViewPresentation: (
    gameRendererId: number,
  ) => Effect.Effect<GameViewPresentation, DesktopWindowError>;
  readonly observe: (
    filter: { readonly kind?: DesktopRendererKind },
    listener: (event: DesktopRendererEvent) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly open: (
    kind: DesktopWindowKind,
    options?: DesktopWindowOpenOptions,
  ) => Effect.Effect<number, DesktopWindowError>;
  readonly revealRenderer: (rendererId: number) => Effect.Effect<boolean>;
  /** Reloads the tab strip and selected client when they form one focused view. */
  readonly reloadFocusedGameContents: (
    nativeWindowId: number,
    focusedRendererId: number,
    bypassCache: boolean,
  ) => Effect.Effect<boolean, DesktopWindowError>;
  readonly setBackgroundColor: (backgroundColor: string) => Effect.Effect<void>;
  readonly setGameViewName: (
    gameRendererId: number,
    name: string,
  ) => Effect.Effect<void, DesktopWindowError>;
  readonly withGameViewGroupControlsNativeDialog: <A, E, R>(
    hostRendererId: number,
    use: (parentWindowId: number) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, DesktopWindowError | E, R>;
}

export class DesktopWindows extends Context.Service<
  DesktopWindows,
  DesktopWindowsShape
>()("lucent/desktop/window/DesktopWindows") {}

export const requireRenderer = (
  windows: Pick<DesktopWindowsShape, "describe">,
  rendererId: number,
): Effect.Effect<DesktopRendererInfo, DesktopWindowError> =>
  Effect.flatMap(windows.describe(rendererId), (info) =>
    info === undefined
      ? Effect.fail(
          new DesktopWindowError({
            id: String(rendererId),
            detail: `Desktop renderer is not open: ${rendererId}`,
          }),
        )
      : Effect.succeed(info),
  );

export interface DesktopWindowOpenOptions {
  readonly gameHostTarget?: DesktopGameHostTarget;
  readonly gameViewLayout?: GameViewLayout;
  readonly gameViewName?: string;
  readonly managedGameProfileKey?: string;
  readonly onCreated?: (
    event: DesktopWindowCreatedEvent,
  ) => Effect.Effect<void, unknown>;
  readonly ownerRendererId?: number;
}

export type DesktopGameHostTarget =
  | { readonly kind: "available" }
  | { readonly kind: "game-view"; readonly rendererId: number }
  | { readonly kind: "new" };

interface DesktopBrowserWindowRecord {
  readonly scope: Scope.Closeable;
  readonly rendererId: number;
  lifetime: CloseableRendererLifetime;
  readonly kind: DesktopWindowKind;
  // ownerId is logical ownership only; Electron parent windows are intentionally not used.
  readonly ownerId?: number;
  rendererReady: boolean;
  hidden: boolean;
  loggedInUsername?: string;
  publishedPresentation?: GameViewPresentation;
  readonly window: ElectronWindowHandle;
}

type DesktopWindowRecord = DesktopBrowserWindowRecord | DesktopGameViewRecord;

interface DesktopChromeRendererRecord {
  readonly rendererId: number;
  readonly scope: Scope.Closeable;
  lifetime: CloseableRendererLifetime;
  readonly kind: "game-host" | "game-group-controls";
  readonly host: DesktopGameHostRecord;
}

type DesktopRendererRecord = DesktopWindowRecord | DesktopChromeRendererRecord;

export interface DesktopWindowCreatedEvent {
  readonly rendererId: number;
  readonly generation: number;
  readonly kind: DesktopWindowKind;
}

export type DesktopRendererEvent = {
  readonly rendererId: number;
  readonly kind: DesktopRendererKind;
  readonly generation: number;
} & (
  | {
      readonly type: "created" | "ready" | "reloaded";
    }
  | {
      readonly type: "crashed";
      readonly reason: RenderProcessGoneDetails["reason"];
    }
  | { readonly type: "closed" }
);

const isGameViewRecord = (
  record: DesktopWindowRecord | undefined,
): record is DesktopGameViewRecord =>
  record !== undefined && "gameView" in record;

const nativeWindowForRenderer = (
  record: DesktopWindowRecord,
): ElectronNativeWindowHandle =>
  isGameViewRecord(record) ? record.hostWindow : record.window;

const preventWindowClose = (event: unknown): void => {
  if (
    typeof event === "object" &&
    event !== null &&
    "preventDefault" in event &&
    typeof event.preventDefault === "function"
  ) {
    event.preventDefault();
  }
};

const standaloneGameViewPresentation = (
  window: ElectronWindowHandle,
): GameViewPresentation => ({
  active: true,
  layout: "focused",
  tiled: false,
  windowActive: window.isFocused(),
});

const publishStandaloneGameViewPresentation = (
  record: DesktopBrowserWindowRecord,
): void => {
  if (record.kind !== "game" || record.window.webContents.isDestroyed()) {
    return;
  }

  const presentation = standaloneGameViewPresentation(record.window);
  if (
    record.publishedPresentation?.active === presentation.active &&
    record.publishedPresentation.layout === presentation.layout &&
    record.publishedPresentation.tiled === presentation.tiled &&
    record.publishedPresentation.windowActive === presentation.windowActive
  ) {
    return;
  }
  record.publishedPresentation = presentation;
  record.window.webContents.send(
    GameViewsIpc.presentationChanged.channel,
    presentation,
  );
};

const makeDesktopWindows = Effect.gen(function* () {
  const layerScope = yield* Effect.scope;
  const socketProxy = yield* RuffleSocketProxy;
  const gameSocketRelayUrl = socketProxy.getUrl;
  const app = yield* ElectronApp;
  const env = yield* DesktopEnvironment;
  const electronWindow = yield* ElectronWindow;
  const electronSession = yield* ElectronSession;
  const electronShell = yield* ElectronShell;
  const settings = yield* DesktopSettings;
  const theme = yield* ElectronTheme;
  const run = yield* FiberSet.makeRuntime<never, void>();
  const listen = <Args extends unknown[]>(
    target: Pick<NodeJS.EventEmitter, "on" | "removeListener"> &
      Pick<ElectronNativeWindowHandle, "id" | "isDestroyed">,
    event: string,
    handler: (...args: Args) => void,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (...args: Args): void => {
          try {
            handler(...args);
          } catch (cause) {
            run(
              logFailure(
                "Electron event handler failed",
                Cause.die(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "window",
                  data: { event, targetId: target.id },
                }),
              ),
            );
          }
        };
        target.on(event, listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          if (!target.isDestroyed()) target.removeListener(event, listener);
        }),
    ).pipe(Effect.asVoid);
  const closeScope = (
    scope: Scope.Closeable,
    exit: Exit.Exit<unknown, unknown>,
  ) =>
    Scope.close(scope, exit).pipe(
      Effect.uninterruptible,
      Effect.catchCause((cause) =>
        logFailure("Failed to clean up a desktop window", cause, {
          failure: "warning",
        }).pipe(Effect.annotateLogs({ component: "window" })),
      ),
    );
  const dispose = (scope: Scope.Closeable): void => {
    run(closeScope(scope, Exit.void));
  };
  const inScope = Effect.fn("DesktopWindows.inScope")(function* <A, E, R>(
    parent: Scope.Scope,
    acquire: (scope: Scope.Closeable) => Effect.Effect<A, E, R>,
  ) {
    if (parent.state._tag === "Closed") {
      return yield* new DesktopWindowError({
        id: "scope",
        detail: "The owning window closed.",
      });
    }
    const scope = yield* Scope.fork(parent);
    return yield* Effect.suspend(() => acquire(scope)).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => closeScope(scope, Exit.failCause(cause))),
    );
  });
  const activeBranding = env.isDev ? appBranding.dev : appBranding.production;
  const getBootstrapSettings = settings.get.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Falling back to default settings for window bootstrap",
        Cause.fail(cause),
      )
        .pipe(Effect.annotateLogs({ component: "window" }))
        .pipe(Effect.as(DEFAULT_APP_SETTINGS)),
    ),
  );
  const initialSettings = yield* getBootstrapSettings;
  let showGameUsernameInWindowTitle =
    initialSettings.preferences.showGameUsernameInWindowTitle;
  const renderers = new Map<number, DesktopRendererRecord>();
  const closingWindows = new WeakSet<ElectronNativeWindowHandle>();
  const getWindowRenderer = (id: number): DesktopWindowRecord | undefined => {
    const record = renderers.get(id);
    return record !== undefined && !("host" in record) ? record : undefined;
  };
  const getGameViewRecord = (id: number): DesktopGameViewRecord | undefined => {
    const record = getWindowRenderer(id);
    return isGameViewRecord(record) ? record : undefined;
  };
  const findGameHost = (id: number): DesktopGameHostRecord | null => {
    const record = renderers.get(id);
    if (record !== undefined && "gameHostRendererId" in record)
      return findGameHost(record.gameHostRendererId);
    return record !== undefined &&
      "host" in record &&
      record.host.scope.state._tag !== "Closed" &&
      !record.host.nativeCloseRequested
      ? record.host
      : null;
  };
  const getGameHosts = function* () {
    for (const record of renderers.values()) {
      if (record.kind !== "game-host") continue;
      const host = findGameHost(record.rendererId);
      if (host !== null) yield host;
    }
  };
  const setGameWindowTitle = (
    window: ElectronNativeWindowHandle,
    username: string | undefined,
  ): void => {
    if (!isElectronWindowUsable(window)) return;
    try {
      window.setTitle(
        formatGameWindowTitle(
          activeBranding.displayName,
          showGameUsernameInWindowTitle,
          username,
        ),
      );
    } catch {}
  };
  const refreshGameHostWindowTitle = (host: DesktopGameHostRecord): void => {
    setGameWindowTitle(host.window, host.selected.loggedInUsername);
  };
  const refreshStandaloneGameWindowTitle = (
    record: DesktopBrowserWindowRecord,
  ): void => setGameWindowTitle(record.window, record.loggedInUsername);
  const gameHosts = makeDesktopGameHosts({
    onStateChanged: refreshGameHostWindowTitle,
    platform: env.platform,
  });
  const unsubscribeWindowTitleSettings = yield* settings.onChanged(
    (nextSettings) => {
      const nextValue = nextSettings.preferences.showGameUsernameInWindowTitle;
      if (showGameUsernameInWindowTitle === nextValue) return;
      showGameUsernameInWindowTitle = nextValue;
      for (const record of renderers.values()) {
        if (record.kind === "game-host")
          refreshGameHostWindowTitle(record.host);
        if (record.kind === "game" && !isGameViewRecord(record)) {
          refreshStandaloneGameWindowTitle(record);
        }
      }
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeWindowTitleSettings));
  const events = makeListenerRegistry<DesktopRendererEvent>();
  const publish = (event: DesktopRendererEvent) =>
    events.publish(
      event,
      event.type === "created" || event.type === "ready" ? 1 : "unbounded",
    );
  const observe: DesktopWindowsShape["observe"] = (filter, listener) =>
    Effect.acquireRelease(
      events.subscribe((event) =>
        filter.kind === undefined || filter.kind === event.kind
          ? listener(event)
          : Effect.void,
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid);

  let appIsQuitting = false;
  let hasOpenedTopLevelWindow = false;
  let quitRequested = false;
  // An in-flight top-level open is recoverable UI during a concurrent close.
  let openingTopLevelWindowCount = 0;

  const openAllowedGameUrl = (rawUrl: string): void => {
    const url = parseAllowedGameWindowOpenUrl(rawUrl);
    if (url === null) {
      return;
    }

    run(
      electronShell.openExternal(url).pipe(
        Effect.flatMap((opened) =>
          opened
            ? Effect.void
            : Effect.logWarning("Failed to open game URL").pipe(
                Effect.annotateLogs({
                  component: "window",
                  data: {
                    url,
                  },
                }),
              ),
        ),
      ),
    );
  };

  const unsubscribeBeforeQuit = yield* app.on("before-quit", () => {
    appIsQuitting = true;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeBeforeQuit));

  const hasPresentableTopLevelWindow = (): boolean =>
    [...renderers.values()].some(
      (record) =>
        !("host" in record) &&
        getDesktopWindowDefinition(record.kind).scope !== "game-child" &&
        (isGameViewRecord(record) || !record.hidden),
    );

  const quitIfNoTopLevelWindow = (): void => {
    if (
      env.platform === "darwin" ||
      appIsQuitting ||
      quitRequested ||
      openingTopLevelWindowCount > 0 ||
      hasPresentableTopLevelWindow()
    ) {
      return;
    }

    quitRequested = true;
    run(
      app.quit.pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            quitRequested = false;
          }),
        ),
      ),
    );
  };

  const revealRenderer: DesktopWindowsShape["revealRenderer"] = (id) =>
    Effect.gen(function* () {
      const record = getWindowRenderer(id);
      if (record === undefined) return false;
      if (isGameViewRecord(record)) {
        const host = findGameHost(record.gameHostRendererId);
        if (host === null) return false;
        gameHosts.focus(host, id);
      }
      yield* electronWindow.reveal(nativeWindowForRenderer(record));
      if (!isGameViewRecord(record)) record.hidden = false;
      return true;
    });

  const findGameHostForView = (
    rendererId: number,
  ): DesktopGameHostRecord | null => {
    const record = getGameViewRecord(rendererId);
    return record === undefined
      ? null
      : findGameHost(record.gameHostRendererId);
  };

  const reloadFocusedGameContents: DesktopWindowsShape["reloadFocusedGameContents"] =
    (nativeWindowId, focusedRendererId, bypassCache) =>
      Effect.try({
        try: () => {
          const host = [...getGameHosts()].find(
            (host) => host.window.id === nativeWindowId,
          );
          if (host === undefined || host.layout !== "focused") {
            return false;
          }

          const selected = host.selected;
          if (
            focusedRendererId !== host.rendererId &&
            focusedRendererId !== selected.rendererId
          ) {
            return false;
          }

          // The tab strip and selected Flash client are separate renderers but
          // present as one focused view.
          const targets = [
            host.hostView.webContents,
            selected.gameView.webContents,
          ];
          for (const target of targets) {
            if (bypassCache) {
              target.reloadIgnoringCache();
            } else {
              target.reload();
            }
          }
          return true;
        },
        catch: (cause) =>
          new DesktopWindowError({
            cause,
            detail: "Failed to reload the focused game view.",
            id: String(nativeWindowId),
          }),
      });

  const getVisibleParentWindow = (
    record: DesktopRendererRecord,
  ): ElectronNativeWindowHandle | undefined => {
    if (
      "host" in record
        ? record.kind !== "game-host"
        : isGameViewRecord(record) ||
          getDesktopWindowDefinition(record.kind).scope === "game-child"
    ) {
      return undefined;
    }
    const scope = "host" in record ? record.host.scope : record.scope;
    const window =
      "host" in record ? record.host.window : nativeWindowForRenderer(record);
    return scope.state._tag !== "Closed" &&
      !closingWindows.has(window) &&
      isElectronWindowUsable(window) &&
      window.isVisible()
      ? window
      : undefined;
  };

  const getVisibleParentWindowId = Effect.sync(() => {
    for (const record of renderers.values()) {
      const window = getVisibleParentWindow(record);
      if (window !== undefined) {
        return window.id;
      }
    }
    return undefined;
  });

  const isVisibleParentWindow: DesktopWindowsShape["isVisibleParentWindow"] = (
    windowId,
  ) =>
    Effect.sync(() => {
      for (const record of renderers.values()) {
        if (getVisibleParentWindow(record)?.id === windowId) return true;
      }
      return false;
    });

  const describe: DesktopWindowsShape["describe"] = (rendererId) =>
    Effect.sync(() => {
      const record = renderers.get(rendererId);
      if (record === undefined) return undefined;
      const chrome = "host" in record;
      return {
        rendererId,
        kind: record.kind,
        windowId: chrome
          ? record.host.window.id
          : nativeWindowForRenderer(record).id,
        ownerId: chrome ? undefined : record.ownerId,
        generation: record.lifetime.generation,
        ready: chrome ? false : record.rendererReady,
      };
    });

  const identify: DesktopWindowsShape["identify"] = (rendererId) =>
    Effect.sync(() => {
      const record = renderers.get(rendererId);
      return record === undefined
        ? undefined
        : {
            rendererId,
            kind: record.kind,
            lifetime: record.lifetime,
          };
    });

  const lifetime: DesktopWindowsShape["lifetime"] = (rendererId) =>
    Effect.sync(() => renderers.get(rendererId)?.lifetime);

  const makeLifetime = (
    rendererId: number,
    generation: number,
    parent: Scope.Scope,
  ) => {
    const scope = Scope.forkUnsafe(parent);
    const lifetime: CloseableRendererLifetime = {
      rendererId,
      generation,
      scope,
      isCurrent: () =>
        renderers.get(rendererId)?.lifetime === lifetime &&
        parent.state._tag !== "Closed" &&
        scope.state._tag !== "Closed",
    };
    return lifetime;
  };

  const endLifetime = (record: DesktopRendererRecord): void => {
    const cleanup = Scope.closeUnsafe(record.lifetime.scope, Exit.void);
    if (cleanup !== undefined) run(Effect.uninterruptible(cleanup));
  };

  const getRendererIds: DesktopWindowsShape["getRendererIds"] = (kind) =>
    Effect.sync(() =>
      [...renderers.values()]
        .filter((record) => record.kind === kind)
        .map((record) => record.rendererId),
    );

  const markRendererReady: DesktopWindowsShape["markRendererReady"] = (
    lifetime,
  ) =>
    Effect.gen(function* () {
      const { rendererId, generation } = lifetime;
      const readyEvent = yield* Effect.try({
        try: () => {
          const record = getWindowRenderer(rendererId);
          if (record === undefined) {
            throw new Error(`Desktop window is not open: ${rendererId}`);
          }

          if (record.lifetime !== lifetime) {
            throw new Error(
              `Renderer generation ${generation} is stale; current generation is ${record.lifetime.generation}.`,
            );
          }
          if (!lifetime.isCurrent()) {
            throw new Error(
              `Renderer generation ${generation} is unavailable.`,
            );
          }
          if (record.rendererReady) {
            return null;
          }

          record.rendererReady = true;
          if (isGameViewRecord(record)) {
            record.gameViewPhase = "ready";
            delete record.gameViewError;
            const host = findGameHost(record.gameHostRendererId);
            if (host !== null) {
              gameHosts.publishState(host);
            }
          }
          return {
            type: "ready",
            rendererId,
            generation: record.lifetime.generation,
            kind: record.kind,
          } satisfies DesktopRendererEvent;
        },
        catch: (cause) =>
          new DesktopWindowError({
            id: String(rendererId),
            detail: `Failed to mark renderer ready: ${rendererId}`,
            cause,
          }),
      });

      if (readyEvent === null) {
        return;
      }

      yield* publish(readyEvent);
    });

  const getOwnedRendererIds: DesktopWindowsShape["getOwnedRendererIds"] = (
    ownerRendererId,
    kind,
  ) =>
    Effect.try({
      try: () => {
        if (getWindowRenderer(ownerRendererId) === undefined) {
          throw new Error(
            `Desktop window owner is not open: ${ownerRendererId}`,
          );
        }

        return [...renderers.values()]
          .filter(
            (record) =>
              !("host" in record) &&
              record.ownerId === ownerRendererId &&
              (kind === undefined || record.kind === kind),
          )
          .map((record) => record.rendererId);
      },
      catch: (cause) =>
        new DesktopWindowError({
          id: String(ownerRendererId),
          detail: `Failed to resolve owned Electron windows: ${ownerRendererId}`,
          cause,
        }),
    });

  // Added before the partition lease so listeners run after its release: a
  // listener that reopens the same profile must get its persistent partition.
  const publishClosedOnClose = (
    scope: Scope.Scope,
    kind: DesktopWindowKind,
  ): Effect.Effect<(record: DesktopWindowRecord) => void> => {
    let record: DesktopWindowRecord | undefined;
    return Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        if (record !== undefined) {
          run(
            publish({
              type: "closed",
              rendererId: record.rendererId,
              generation: record.lifetime.generation,
              kind,
            }),
          );
        }
      }),
    ).pipe(
      Effect.as((closed: DesktopWindowRecord) => {
        record = closed;
      }),
    );
  };

  const unregisterGameView = (
    host: DesktopGameHostRecord,
    record: DesktopGameViewRecord,
  ): void => {
    const id = record.rendererId;
    const removedIndex = host.tabs.indexOf(record);

    renderers.delete(id);
    if (host.scope.state._tag === "Closed" || host.nativeCloseRequested) return;

    if (isElectronWindowUsable(host.window)) {
      try {
        host.window.contentView.removeChildView(record.gameView.native);
      } catch {}
    }
    host.tabs.splice(removedIndex, 1);
    host.groupTargets.delete(record);
    if (host.stacked === record) {
      delete host.stacked;
    }
    if (host.tabs.length === 0) {
      host.nativeCloseRequested = true;
      host.window.close();
      return;
    }

    if (host.tabs.length === 1) {
      host.layout = "focused";
    }

    if (host.selected === record) {
      host.selected = host.tabs[Math.min(removedIndex, host.tabs.length - 1)]!;
    }
    gameHosts.refresh(host);
  };

  const closeRenderer: DesktopWindowsShape["closeRenderer"] = (rendererId) =>
    Effect.suspend(() => {
      const record = getWindowRenderer(rendererId);
      if (record === undefined) {
        return Effect.succeed(false);
      }

      if (isGameViewRecord(record)) {
        return closeScope(record.scope, Exit.void).pipe(Effect.as(true));
      }
      record.window.close();
      return Effect.succeed(true);
    });

  const setBackgroundColor: DesktopWindowsShape["setBackgroundColor"] = (
    backgroundColor,
  ) =>
    Effect.forEach(
      renderers.entries(),
      ([id, record]) => {
        if ("host" in record) return Effect.void;
        const nativeWindow = nativeWindowForRenderer(record);
        if (!isElectronWindowUsable(nativeWindow)) {
          return Effect.void;
        }

        return Effect.try({
          try: () => {
            nativeWindow.setBackgroundColor(backgroundColor);
            if (isGameViewRecord(record)) {
              record.gameView.setBackgroundColor(backgroundColor);
            }
          },
          catch: (cause) =>
            new DesktopWindowError({
              id: String(id),
              detail: `Failed to update desktop window background: ${id}`,
              cause,
            }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to update desktop window background",
              Cause.fail(cause),
            ).pipe(Effect.annotateLogs({ component: "window", data: { id } })),
          ),
        );
      },
      { discard: true },
    );

  const findOpenInstance = (
    kind: DesktopWindowKind,
    ownerId: number | undefined,
  ): DesktopWindowRecord | undefined =>
    [...renderers.values()].find(
      (record): record is DesktopWindowRecord =>
        !("host" in record) &&
        record.kind === kind &&
        record.ownerId === ownerId,
    );

  const updateGameViewPhase = (
    id: number,
    phase: DesktopGameViewRecord["gameViewPhase"],
    error?: string,
  ): void => {
    const record = getGameViewRecord(id);
    if (record === undefined) return;

    if (record.gameViewPhase === phase && record.gameViewError === error) {
      return;
    }

    record.gameViewPhase = phase;
    if (error === undefined) {
      delete record.gameViewError;
    } else {
      record.gameViewError = error;
    }
    const host = findGameHost(record.gameHostRendererId);
    if (host !== null) {
      gameHosts.publishState(host);
    }
  };

  const track = Effect.fn("DesktopWindows.track")(
    function* (
      ...[record, host]:
        | [record: DesktopBrowserWindowRecord | DesktopChromeRendererRecord]
        | [record: DesktopGameViewRecord, host: DesktopGameHostRecord]
    ) {
      const contents =
        "host" in record
          ? record.kind === "game-host"
            ? record.host.hostView.webContents
            : record.host.groupControlsView.webContents
          : isGameViewRecord(record)
            ? record.gameView.webContents
            : record.window.webContents;
      const { rendererId, kind } = record;
      let initialDocumentCommitted = false;
      contents.once("destroyed", () => dispose(record.scope));
      yield* listen(
        contents,
        "render-process-gone",
        (_event: ElectronEvent, details: RenderProcessGoneDetails) => {
          if (!("host" in record)) record.rendererReady = false;
          endLifetime(record);
          if (host !== undefined) {
            updateGameViewPhase(
              rendererId,
              "error",
              "The game stopped unexpectedly.",
            );
          }
          run(
            publish({
              type: "crashed",
              rendererId,
              kind,
              generation: record.lifetime.generation,
              reason: details.reason,
            }),
          );
        },
      );
      const commitDocument = (): void => {
        if (!initialDocumentCommitted) {
          initialDocumentCommitted = true;
          if (record.lifetime.isCurrent()) return;
        }
        const generation = record.lifetime.generation + 1;
        endLifetime(record);
        record.lifetime = makeLifetime(rendererId, generation, record.scope);
        if (!("host" in record)) record.rendererReady = false;
        if (host !== undefined) updateGameViewPhase(rendererId, "loading");
        run(
          publish({
            type: "reloaded",
            rendererId,
            kind,
            generation: record.lifetime.generation,
          }),
        );
      };
      yield* listen(contents, "did-navigate", commitDocument);
      yield* listen(
        contents,
        "did-fail-provisional-load",
        (
          _event: ElectronEvent,
          _code: number,
          _description: string,
          _url: string,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) commitDocument();
        },
      );
      if (host === undefined || "host" in record || !isGameViewRecord(record))
        return;
      yield* listen(
        contents,
        "did-fail-load",
        (
          _event: ElectronEvent,
          code: number,
          description: string,
          _url: string,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame && code !== -3)
            updateGameViewPhase(rendererId, "error", description);
        },
      );
      yield* listen(contents, "focus", () => {
        gameHosts.activate(host, record);
        if (host.groupControlsOpen && !host.groupControlsNativeDialogOpen) {
          gameHosts.setGroupControlsOpen(host, false);
        }
      });
    },
    (effect, ...[record]) => effect.pipe(Scope.provide(record.scope)),
  );

  const createGameViewInHost = Effect.fn("DesktopWindows.createGameViewInHost")(
    function* (
      scope: Scope.Closeable,
      host: DesktopGameHostRecord,
      bootstrapSettings: AppSettings,
      snapshot: AppearanceSnapshot,
      options?: DesktopWindowOpenOptions,
    ) {
      if (host.nativeCloseRequested) {
        return yield* new DesktopWindowError({
          id: String(host.rendererId),
          detail: "The game window is closing.",
        });
      }
      if (host.tabs.length >= MAX_GAME_VIEWS_PER_WINDOW) {
        return yield* new DesktopWindowError({
          id: String(host.rendererId),
          detail: `This game window already has ${MAX_GAME_VIEWS_PER_WINDOW} views.`,
        });
      }

      const layout = options?.gameViewLayout ?? "focused";
      const announceClosed = yield* publishClosedOnClose(scope, "game");
      const gamePartition = yield* electronSession
        .acquireGamePartition(gamePartitionOwner(options))
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopWindowError({
                cause,
                detail: "Failed to prepare an isolated Flash session.",
                id: String(host.rendererId),
              }),
          ),
        );
      const view = yield* electronWindow.createView(
        createGameViewOptions(
          env,
          bootstrapSettings,
          snapshot,
          gamePartition,
          layout,
        ),
        openAllowedGameUrl,
      );
      view.setBackgroundColor(snapshot.backgroundColor);

      yield* Effect.try({
        try: () => host.window.contentView.addChildView(view.native),
        catch: (cause) =>
          new DesktopWindowError({
            cause,
            detail: "Failed to attach a game view to its host window.",
            id: String(view.webContents.id),
          }),
      });

      const rendererId = view.webContents.id;
      const gameViewName = normalizeGameViewName(options?.gameViewName);
      const record: DesktopGameViewRecord = {
        boundsLayout: layout,
        rendererId,
        gameHostRendererId: host.rendererId,
        scope,
        gameView: view,
        ...(gameViewName === undefined ? {} : { gameViewName }),
        gameViewPhase: "preparing",
        lifetime: makeLifetime(rendererId, 1, scope),
        kind: "game",
        rendererReady: false,
        hostWindow: host.window,
      };
      // New tabs follow an existing select-all state, but stay excluded from a
      // user-chosen subset.
      const allViewsTargeted = host.groupTargets.size === host.tabs.length;
      renderers.set(rendererId, record);
      announceClosed(record);
      host.tabs.push(record);
      if (allViewsTargeted) {
        host.groupTargets.add(record);
      }
      host.selected = record;
      host.layout = layout;
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => unregisterGameView(host, record)),
      );

      const createdEvent: DesktopWindowCreatedEvent = {
        rendererId,
        generation: 1,
        kind: "game",
      };
      yield* track(record, host);
      yield* listen(
        view.webContents,
        "before-input-event",
        gameHosts.makeShortcutInputListener(host),
      );

      yield* publish({ type: "created", ...createdEvent });
      if (options?.onCreated !== undefined) {
        yield* options.onCreated(createdEvent);
      }

      gameHosts.refresh(host);
      run(
        gameSocketRelayUrl.pipe(
          Effect.flatMap((socketProxy) =>
            electronWindow.loadFile(view.webContents, viewHtmlPath("game"), {
              query: { socketProxy },
            }),
          ),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                "Failed to load game view",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "window",
                  data: { rendererId },
                }),
              );
              updateGameViewPhase(
                rendererId,
                "error",
                cause instanceof ElectronWindowLoadError
                  ? `Failed to load Electron game view file: ${cause.path}.`
                  : cause.message,
              );
            }),
          ),
        ),
      );

      if (env.debug === true) {
        yield* Effect.try({
          try: () => view.webContents.openDevTools({ mode: "detach" }),
          catch: (cause) =>
            new DesktopWindowError({
              cause,
              detail: `Failed to open game view DevTools: ${rendererId}`,
              id: String(rendererId),
            }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to open game view DevTools",
              Cause.fail(cause),
            ).pipe(
              Effect.annotateLogs({
                component: "window",
                data: {
                  rendererId,
                },
              }),
            ),
          ),
        );
      }
      return rendererId;
    },
  );

  const createMultiGameWindow = Effect.fn(
    "DesktopWindows.createMultiGameWindow",
  )(function* (
    scope: Scope.Closeable,
    definition: DesktopWindowDefinition,
    bootstrapSettings: AppSettings,
    snapshot: AppearanceSnapshot,
    options?: DesktopWindowOpenOptions,
  ) {
    yield* Scope.addFinalizer(scope, Effect.sync(quitIfNoTopLevelWindow));
    const window = yield* electronWindow.createHost(
      createNativeWindowOptions(
        env,
        { ...definition, height: definition.height + GAME_VIEW_TAB_BAR_HEIGHT },
        snapshot,
      ),
    );
    yield* listen(window, "close", () => {
      closingWindows.add(window);
    });
    const createChromeView = Effect.fn(function* (
      kind: DesktopChromeRendererRecord["kind"],
    ) {
      const view = yield* electronWindow.createView({
        webPreferences: createRendererWebPreferences(
          env,
          kind,
          bootstrapSettings,
          snapshot,
        ),
      });
      view.setBackgroundColor("#00000000");
      return view;
    });
    const groupControlsView = yield* createChromeView("game-group-controls");
    // The tabs and their overflow menu share one persistent view that expands on demand.
    const hostView = yield* createChromeView("game-host");
    yield* Effect.try({
      try: () => window.contentView.addChildView(hostView.native),
      catch: (cause) =>
        new DesktopWindowError({
          cause,
          detail: "Failed to attach the game host view.",
          id: String(hostView.webContents.id),
        }),
    });
    const hostWebContents = hostView.webContents;
    const host = {
      scope,
      groupControlsNativeDialogOpen: false,
      groupControlsOpen: false,
      groupControlsView,
      groupTargets: new Set<DesktopGameViewRecord>(),
      hostView,
      layout: "focused",
      tabs: [] as DesktopGameViewRecord[],
      rendererId: hostWebContents.id,
      shortcutModifierPressed: false,
      tabMenuOpen: false,
      window,
    } as DesktopGameHostRecord;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => gameHosts.cancelResize(host)),
    );
    const chromeViews = [
      ["game-group-controls", groupControlsView],
      ["game-host", hostView],
    ] as const;
    for (const [kind, view] of chromeViews) {
      const id = view.webContents.id;
      const record: DesktopChromeRendererRecord = {
        rendererId: id,
        kind,
        host,
        scope,
        lifetime: makeLifetime(id, 0, scope),
      };
      renderers.set(id, record);
      yield* track(record);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => renderers.delete(id)),
      );
    }
    yield* listen(
      hostWebContents,
      "before-input-event",
      gameHosts.makeShortcutInputListener(host),
    );
    yield* listen(hostWebContents, "did-start-loading", () => {
      if (host.tabMenuOpen) gameHosts.setTabMenuOpen(host, false);
    });
    yield* listen(window, "resize", () => {
      if (host.tabs.length > 0 && host.tabMenuOpen) {
        gameHosts.setTabMenuOpen(host, false);
      }
    });
    yield* listen(window, "resize", () => {
      if (host.tabs.length > 0) gameHosts.scheduleResize(host);
    });
    yield* listen(window, "resized", () => {
      if (host.tabs.length > 0) gameHosts.finishResize(host);
    });
    yield* listen(window, "focus", () => gameHosts.publishPresentations(host));
    yield* listen(window, "blur", () => {
      gameHosts.publishPresentations(host);
      gameHosts.setShortcutModifierPressed(host, false);
      // A parented native file picker temporarily blurs its host window.
      if (host.groupControlsOpen && !host.groupControlsNativeDialogOpen) {
        gameHosts.setGroupControlsOpen(host, false);
      }
    });
    yield* listen(window, "blur", () => {
      if (host.tabMenuOpen) gameHosts.setTabMenuOpen(host, false);
    });
    window.once("closed", () => dispose(scope));

    const id = yield* inScope(host.scope, (scope) =>
      createGameViewInHost(scope, host, bootstrapSettings, snapshot, options),
    );
    yield* Effect.forEach(
      chromeViews,
      ([kind, view]) =>
        electronWindow.loadFile(view.webContents, viewHtmlPath(kind)).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopWindowError({
                id: String(view.webContents.id),
                detail: `Failed to load Electron game view file: ${cause.path}.`,
                cause: cause.cause,
              }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    yield* electronWindow.reveal(window);
    const initialGameView = getGameViewRecord(id);
    if (
      initialGameView !== undefined &&
      !initialGameView.gameView.webContents.isDestroyed()
    ) {
      // Revealing the window can focus the host's first button and open its
      // tooltip. Start interaction in the game without changing the layout.
      initialGameView.gameView.webContents.focus();
    }
    hasOpenedTopLevelWindow = true;
    yield* Effect.logInfo("Multi-game window opened").pipe(
      Effect.annotateLogs({
        component: "window",
        data: {
          hostRendererId: host.rendererId,
          id,
        },
      }),
    );
    return id;
  });

  const requireGameHost = (
    hostRendererId: number,
  ): Effect.Effect<DesktopGameHostRecord, DesktopWindowError> =>
    Effect.try({
      try: () => {
        const host = findGameHost(hostRendererId);
        if (host === null) {
          throw new Error(`Game view host is not open: ${hostRendererId}`);
        }
        return host;
      },
      catch: (cause) =>
        new DesktopWindowError({
          cause,
          detail: `Failed to resolve game view host: ${hostRendererId}`,
          id: String(hostRendererId),
        }),
    });

  const getGameViewHostState: DesktopWindowsShape["getGameViewHostState"] = (
    hostRendererId,
  ) => requireGameHost(hostRendererId).pipe(Effect.map(gameHosts.state));

  const addGameView: DesktopWindowsShape["addGameView"] = (hostRendererId) =>
    Effect.gen(function* () {
      const host = yield* requireGameHost(hostRendererId);
      if (host.tabs.length >= MAX_GAME_VIEWS_PER_WINDOW) {
        return yield* new DesktopWindowError({
          detail: `This game window already has ${MAX_GAME_VIEWS_PER_WINDOW} views.`,
          id: String(hostRendererId),
        });
      }

      const bootstrapSettings = yield* getBootstrapSettings;
      const systemPrefersDark = yield* theme.shouldUseDarkColors;
      const snapshot = createAppearanceSnapshot(
        bootstrapSettings,
        systemPrefersDark,
      );
      yield* electronSession.prepareGameNetworking;
      yield* inScope(host.scope, (scope) =>
        createGameViewInHost(scope, host, bootstrapSettings, snapshot),
      );
      return gameHosts.state(host);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DesktopWindowError
          ? cause
          : new DesktopWindowError({
              cause,
              detail: "Failed to add a game view.",
              id: String(hostRendererId),
            }),
      ),
    );

  const closeGameView: DesktopWindowsShape["closeGameView"] = (
    hostRendererId,
    id,
  ) =>
    Effect.gen(function* () {
      const host = yield* requireGameHost(hostRendererId);
      const record = getGameViewRecord(id);
      if (
        record === undefined ||
        record.gameHostRendererId !== host.rendererId
      ) {
        return yield* new DesktopWindowError({
          detail: `Game view does not belong to this host: ${id}`,
          id: String(id),
        });
      }
      yield* closeScope(record.scope, Exit.void);
    });

  const updateGameViewHost: DesktopWindowsShape["updateGameViewHost"] = (
    rendererId,
    change,
  ) =>
    Effect.gen(function* () {
      const host = yield* requireGameHost(rendererId);
      if (
        change.type === "select" &&
        !host.tabs.some((record) => record.rendererId === change.id)
      ) {
        return yield* new DesktopWindowError({
          id: String(change.id),
          detail: `Game view does not belong to this host: ${change.id}`,
        });
      }
      if (change.type === "reorder" || change.type === "group-targets") {
        const uniqueIds = new Set(change.ids);
        if (
          uniqueIds.size !== change.ids.length ||
          change.ids.some(
            (id) => !host.tabs.some((record) => record.rendererId === id),
          ) ||
          (change.type === "reorder" && change.ids.length !== host.tabs.length)
        ) {
          return yield* new DesktopWindowError({
            id: String(rendererId),
            detail:
              change.type === "reorder"
                ? "Game view order must contain every open view exactly once."
                : "Group targets must be unique tabs in this game window.",
          });
        }
      }
      yield* Effect.try({
        try: () => {
          switch (change.type) {
            case "select":
              gameHosts.select(host, change.id, change.focus);
              break;
            case "reorder":
              if (
                change.ids.every(
                  (id, index) => host.tabs[index]?.rendererId === id,
                )
              )
                break;
              host.tabs.splice(
                0,
                host.tabs.length,
                ...change.ids.map(
                  (id) => host.tabs.find((record) => record.rendererId === id)!,
                ),
              );
              gameHosts.refresh(host);
              break;
            case "layout":
              if (host.layout === change.layout) break;
              host.layout = change.layout;
              gameHosts.refresh(host);
              break;
            case "group-controls":
              gameHosts.setGroupControlsOpen(host, change.open);
              break;
            case "tab-menu":
              if (change.open && host.groupControlsOpen)
                gameHosts.setGroupControlsOpen(host, false);
              gameHosts.setTabMenuOpen(host, change.open);
              break;
            case "group-targets": {
              const targets = host.tabs.filter((record) =>
                change.ids.includes(record.rendererId),
              );
              if (
                targets.length === host.groupTargets.size &&
                targets.every((record) => host.groupTargets.has(record))
              )
                break;
              host.groupTargets.clear();
              for (const record of targets) host.groupTargets.add(record);
              gameHosts.publishState(host);
              break;
            }
            case "tab-bar-layout":
              gameHosts.syncTabBarLayout(host);
              break;
            default:
              change satisfies never;
          }
        },
        catch: (cause) => {
          const detail = (
            {
              select: `Failed to select game view: ${change.type === "select" ? change.id : ""}`,
              reorder: "Failed to reorder game views.",
              layout: `Failed to use ${change.type === "layout" ? change.layout : ""} game view layout.`,
              "group-controls": `Failed to ${change.type === "group-controls" && change.open ? "open" : "close"} group controls.`,
              "tab-menu": "Failed to update the tab menu.",
              "group-targets": undefined,
              "tab-bar-layout":
                "Failed to synchronize the game view tab bar layout.",
            } satisfies Record<GameViewHostChange["type"], string | undefined>
          )[change.type];
          if (detail === undefined) throw cause;
          return new DesktopWindowError({
            cause,
            detail,
            id: String(change.type === "select" ? change.id : rendererId),
          });
        },
      });
      return gameHosts.state(host);
    });

  const withGameViewGroupControlsNativeDialog: DesktopWindowsShape["withGameViewGroupControlsNativeDialog"] =
    (hostRendererId, use) =>
      Effect.gen(function* () {
        const host = yield* requireGameHost(hostRendererId);
        host.groupControlsNativeDialogOpen = true;

        return yield* use(host.window.id).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              host.groupControlsNativeDialogOpen = false;
              if (
                host.groupControlsOpen &&
                isElectronWindowUsable(host.window) &&
                !host.groupControlsView.webContents.isDestroyed()
              ) {
                host.window.contentView.addChildView(
                  host.groupControlsView.native,
                );
                host.groupControlsView.webContents.focus();
              }
            }),
          ),
        );
      });

  const getGameViewPresentation: DesktopWindowsShape["getGameViewPresentation"] =
    (gameRendererId) =>
      Effect.try({
        try: () => {
          const record = getWindowRenderer(gameRendererId);
          if (record === undefined || record.kind !== "game") {
            throw new Error(`Game renderer is not open: ${gameRendererId}`);
          }
          if (!isGameViewRecord(record)) {
            return standaloneGameViewPresentation(record.window);
          }
          const host = findGameHost(record.gameHostRendererId);
          if (host === null) {
            throw new Error(`Game view host is not open: ${gameRendererId}`);
          }
          return gameHosts.presentation(host, record);
        },
        catch: (cause) =>
          new DesktopWindowError({
            cause,
            detail: `Failed to resolve game view presentation: ${gameRendererId}`,
            id: String(gameRendererId),
          }),
      });

  const setGameViewName: DesktopWindowsShape["setGameViewName"] = (
    gameRendererId,
    name,
  ) =>
    Effect.try({
      try: () => {
        const record = getWindowRenderer(gameRendererId);
        if (record === undefined || record.kind !== "game") {
          throw new Error(`Game renderer is not open: ${gameRendererId}`);
        }
        const gameViewName = normalizeGameViewName(name);
        if (!isGameViewRecord(record)) {
          if (record.loggedInUsername === gameViewName) return;
          if (gameViewName === undefined) {
            delete record.loggedInUsername;
          } else {
            record.loggedInUsername = gameViewName;
          }
          refreshStandaloneGameWindowTitle(record);
          return;
        }
        if (
          record.gameViewName === gameViewName &&
          record.loggedInUsername === gameViewName
        ) {
          return;
        }
        if (gameViewName === undefined) {
          delete record.gameViewName;
          delete record.loggedInUsername;
        } else {
          record.gameViewName = gameViewName;
          record.loggedInUsername = gameViewName;
        }
        const host = findGameHost(record.gameHostRendererId);
        if (host !== null) {
          gameHosts.publishState(host);
        }
      },
      catch: (cause) =>
        new DesktopWindowError({
          cause,
          detail: `Failed to update game view name: ${gameRendererId}`,
          id: String(gameRendererId),
        }),
    });

  const pendingOpens = new Map<
    string,
    Deferred.Deferred<number, DesktopWindowError>
  >();

  const open: DesktopWindowsShape["open"] = (kind, options) =>
    Effect.gen(function* () {
      const definition = getDesktopWindowDefinition(kind);
      const owner = yield* Effect.try({
        try: () => {
          if (definition.scope !== "game-child") {
            if (options?.ownerRendererId !== undefined) {
              throw new Error(
                `${kind} does not accept a logical owner window.`,
              );
            }
            return undefined;
          }

          if (options?.ownerRendererId === undefined) {
            throw new Error(`${kind} requires an owning game window.`);
          }

          const owner = getWindowRenderer(options.ownerRendererId);
          if (
            owner === undefined ||
            owner.kind !== "game" ||
            owner.ownerId !== undefined
          ) {
            throw new Error(
              `The owning window must be an open root game: ${options.ownerRendererId}`,
            );
          }

          return owner;
        },
        catch: (cause) =>
          new DesktopWindowError({
            id: kind,
            detail: `Invalid logical owner for desktop window: ${kind}`,
            cause,
          }),
      });
      const ownerId = owner?.rendererId;
      const isTopLevelWindow = definition.scope !== "game-child";
      const openEffect = Effect.fn(function* (scope: Scope.Closeable) {
        const bootstrapSettings = yield* getBootstrapSettings;
        const systemPrefersDark = yield* theme.shouldUseDarkColors;
        const snapshot = createAppearanceSnapshot(
          bootstrapSettings,
          systemPrefersDark,
        );
        if (kind === "game") {
          yield* electronSession.prepareGameNetworking;
        }

        if (kind === "game" && bootstrapSettings.preferences.useGameTabs) {
          const gameHostTarget = options?.gameHostTarget;
          if (gameHostTarget !== undefined && gameHostTarget.kind !== "new") {
            const reusableHost =
              gameHostTarget.kind === "available"
                ? [...getGameHosts()].find(
                    (host) => host.tabs.length < MAX_GAME_VIEWS_PER_WINDOW,
                  )
                : (findGameHostForView(gameHostTarget.rendererId) ?? undefined);
            if (reusableHost !== undefined) {
              yield* Scope.close(scope, Exit.void);
              return yield* inScope(reusableHost.scope, (scope) =>
                createGameViewInHost(
                  scope,
                  reusableHost,
                  bootstrapSettings,
                  snapshot,
                  options,
                ).pipe(
                  Effect.tap(() => electronWindow.reveal(reusableHost.window)),
                ),
              );
            }
            if (gameHostTarget.kind === "game-view") {
              return yield* new DesktopWindowError({
                detail: `The target game window is not open: ${gameHostTarget.rendererId}`,
                id: String(gameHostTarget.rendererId),
              });
            }
          }

          return yield* createMultiGameWindow(
            scope,
            definition,
            bootstrapSettings,
            snapshot,
            options,
          );
        }

        if (isTopLevelWindow) {
          yield* Scope.addFinalizer(scope, Effect.sync(quitIfNoTopLevelWindow));
        }
        const announceClosed = yield* publishClosedOnClose(scope, kind);
        const gamePartition =
          kind === "game"
            ? yield* electronSession.acquireGamePartition(
                gamePartitionOwner(options),
              )
            : undefined;
        const window = yield* electronWindow.create(
          createWindowOptions(
            env,
            definition,
            bootstrapSettings,
            snapshot,
            gamePartition === undefined
              ? undefined
              : {
                  bridgeView: "game",
                  partition: gamePartition,
                },
          ),
          kind === "game" ? openAllowedGameUrl : undefined,
        );
        const webContents = window.webContents;
        const rendererId = webContents.id;
        const record: DesktopBrowserWindowRecord = {
          rendererId,
          lifetime: makeLifetime(rendererId, 1, scope),
          kind,
          scope,
          ...(ownerId === undefined ? {} : { ownerId }),
          rendererReady: false,
          hidden: false,
          window,
        };
        renderers.set(rendererId, record);
        announceClosed(record);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => renderers.delete(rendererId)),
        );
        if (kind === "game" && !isGameViewRecord(record)) {
          yield* listen(
            window,
            "page-title-updated",
            (event: ElectronEvent) => {
              event.preventDefault();
              refreshStandaloneGameWindowTitle(record);
            },
          );
          yield* listen(window, "focus", () =>
            publishStandaloneGameViewPresentation(record),
          );
          yield* listen(window, "blur", () =>
            publishStandaloneGameViewPresentation(record),
          );
          refreshStandaloneGameWindowTitle(record);
        }
        const createdEvent: DesktopWindowCreatedEvent = {
          rendererId,
          generation: 1,
          kind,
        };
        yield* track(record);

        yield* listen(window, "close", (event: ElectronEvent) => {
          if (
            definition.closeBehavior === "hide" &&
            !appIsQuitting &&
            !window.isDestroyed()
          ) {
            preventWindowClose(event);
            window.hide();
            if (isTopLevelWindow) {
              record.hidden = true;
              quitIfNoTopLevelWindow();
            }
            return;
          }
          closingWindows.add(window);
        });

        window.once("closed", () => dispose(scope));

        yield* publish({ type: "created", ...createdEvent });

        if (options?.onCreated !== undefined) {
          yield* options.onCreated(createdEvent);
        }

        const socketProxy =
          kind === "game" ? yield* gameSocketRelayUrl : undefined;
        yield* electronWindow.loadFile(
          webContents,
          viewHtmlPath(definition.kind),
          socketProxy === undefined ? undefined : { query: { socketProxy } },
        );
        if (env.debug === true) {
          yield* Effect.try({
            try: () => webContents.openDevTools({ mode: "detach" }),
            catch: (cause) =>
              new DesktopWindowError({
                id: String(rendererId),
                detail: `Failed to open DevTools for desktop window: ${rendererId}`,
                cause,
              }),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Failed to open DevTools",
                Cause.fail(cause),
              ).pipe(
                Effect.annotateLogs({
                  component: "window",
                  data: {
                    rendererId,
                    kind,
                  },
                }),
              ),
            ),
          );
        }
        yield* electronWindow.reveal(window);
        if (isTopLevelWindow) {
          record.hidden = false;
          hasOpenedTopLevelWindow = true;
        }
        yield* Effect.logInfo("Desktop window opened").pipe(
          Effect.annotateLogs({
            component: "window",
            data: {
              rendererId,
              kind,
            },
          }),
        );
        return rendererId;
      });
      const createWindow = Effect.acquireUseRelease(
        Effect.sync(() => {
          if (isTopLevelWindow) {
            openingTopLevelWindowCount += 1;
          }
        }),
        () =>
          inScope(owner?.scope ?? layerScope, openEffect).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopWindowError({
                  id: kind,
                  detail: `Failed to open desktop window: ${kind}`,
                  cause,
                }),
            ),
          ),
        () =>
          Effect.sync(() => {
            if (!isTopLevelWindow) {
              return;
            }

            openingTopLevelWindowCount -= 1;
            quitIfNoTopLevelWindow();
          }),
      );
      if (!definition.singleInstance) {
        return yield* createWindow;
      }

      return yield* Effect.uninterruptibleMask((restore) => {
        const key = `${kind}:${ownerId ?? "application"}`;
        const pending = pendingOpens.get(key);
        if (pending !== undefined) {
          return restore(Deferred.await(pending));
        }

        const existing = findOpenInstance(kind, ownerId);
        if (existing !== undefined) {
          return restore(revealRenderer(existing.rendererId)).pipe(
            Effect.as(existing.rendererId),
          );
        }

        const result = Deferred.makeUnsafe<number, DesktopWindowError>();
        pendingOpens.set(key, result);
        return restore(createWindow).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              pendingOpens.delete(key);
              Deferred.doneUnsafe(result, exit);
            }),
          ),
        );
      });
    });

  const restorePrimaryWindow = Effect.fn("DesktopWindows.restorePrimaryWindow")(
    function* () {
      if (
        appIsQuitting ||
        !hasOpenedTopLevelWindow ||
        openingTopLevelWindowCount > 0 ||
        hasPresentableTopLevelWindow()
      ) {
        return;
      }

      const accountManager = findOpenInstance("account-manager", undefined);
      if (accountManager !== undefined) {
        if (yield* revealRenderer(accountManager.rendererId)) {
          return;
        }
      }

      const currentSettings = yield* getBootstrapSettings;
      yield* open(
        currentSettings.preferences.launchMode === "account-manager"
          ? "account-manager"
          : "game",
      );
    },
  );

  if (env.platform === "darwin") {
    const unsubscribeActivate = yield* app.on("activate", () => {
      run(
        restorePrimaryWindow().pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to restore a primary window after macOS activation",
              Cause.fail(cause),
            ).pipe(Effect.annotateLogs({ component: "window" })),
          ),
        ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeActivate));
  }

  return DesktopWindows.of({
    updateGameViewHost,
    addGameView,
    closeRenderer,
    closeGameView,
    getRendererIds,
    describe,
    identify,
    lifetime,
    getVisibleParentWindowId,
    isVisibleParentWindow,
    getGameViewHostState,
    getGameViewPresentation,
    getOwnedRendererIds,
    markRendererReady,
    observe,
    open,
    revealRenderer,
    reloadFocusedGameContents,
    setBackgroundColor,
    setGameViewName,
    withGameViewGroupControlsNativeDialog,
  });
});

export const layer = Layer.effect(DesktopWindows, makeDesktopWindows);
