import type { Event as ElectronEvent, Input } from "electron";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { logFailure } from "../../shared/logFailure";
import type * as Scope from "effect/Scope";
import type { CloseableRendererLifetime } from "./DesktopWindows";

import {
  MAX_GAME_VIEWS_PER_WINDOW,
  gameViewFallbackName,
  scaledGameViewTabBarHeight,
  type GameViewHostState,
  type GameViewLayout,
  type GameViewPresentation,
  type GameViewSelectionFocus,
  type GameViewSession,
} from "../../shared/gameViews";
import { GameViewsIpc, type IpcEventDescriptor } from "../../shared/ipc";
import type {
  ElectronGameViewHandle,
  ElectronNativeWindowHandle,
} from "../electron/ElectronWindow";
import { focusedGameViewBounds, gridGameViewBounds } from "./GameViewLayout";
import {
  readGameViewShortcutIndex,
  readGameViewShortcutModifierHintUpdate,
} from "./GameViewShortcuts";

const GAME_VIEW_RESIZE_SETTLE_DELAY_MS = 100;
const GAME_GROUP_CONTROLS_HEIGHT = 408;
const GAME_GROUP_CONTROLS_MARGIN = 8;
const GAME_GROUP_CONTROLS_WIDTH = 392;

export interface DesktopGameViewRecord {
  /** The layout whose bounds this view has, which can differ from its host's. */
  boundsLayout: GameViewLayout;
  readonly gameHostRendererId: number;
  readonly scope: Scope.Closeable;
  readonly gameView: ElectronGameViewHandle;
  gameViewError?: string;
  gameViewName?: string;
  gameViewPhase: GameViewSession["phase"];
  lifetime: CloseableRendererLifetime;
  readonly hostWindow: ElectronNativeWindowHandle;
  readonly kind: "game";
  loggedInUsername?: string;
  readonly ownerId?: number;
  publishedPresentation?: GameViewPresentation;
  readonly rendererId: number;
  rendererReady: boolean;
}

export interface DesktopGameHostRecord {
  readonly scope: Scope.Closeable;
  nativeCloseRequested?: true;
  groupControlsNativeDialogOpen: boolean;
  readonly groupControlsView: ElectronGameViewHandle;
  groupControlsOpen: boolean;
  readonly groupTargets: Set<DesktopGameViewRecord>;
  readonly hostView: ElectronGameViewHandle;
  readonly rendererId: number;
  layout: GameViewLayout;
  readonly tabs: DesktopGameViewRecord[];
  resizeSettleTimer?: ReturnType<typeof setTimeout>;
  selected: DesktopGameViewRecord;
  shortcutModifierPressed: boolean;
  stacked?: DesktopGameViewRecord;
  tabMenuOpen: boolean;
  readonly window: ElectronNativeWindowHandle;
}

interface DesktopGameHostsOptions {
  readonly onStateChanged: (host: DesktopGameHostRecord) => void;
  readonly platform: NodeJS.Platform;
}

/** Normalizes the optional label displayed for a hosted game view. */
export const normalizeGameViewName = (
  value: string | undefined,
): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === ""
    ? undefined
    : normalized.slice(0, 64);
};

const sameGameViewPresentation = (
  left: GameViewPresentation,
  right: GameViewPresentation,
): boolean =>
  left.active === right.active &&
  left.layout === right.layout &&
  left.tiled === right.tiled &&
  left.windowActive === right.windowActive;

export const parseGameViewTabId = (id: string): number => {
  const rendererId = Number(id);
  return Number.isSafeInteger(rendererId) &&
    rendererId > 0 &&
    String(rendererId) === id
    ? rendererId
    : Number.NaN;
};

const gameViewSession = (
  record: DesktopGameViewRecord,
  index: number,
): GameViewSession => ({
  id: String(record.rendererId),
  name: record.gameViewName ?? gameViewFallbackName(index),
  phase: record.gameViewPhase,
  ...(record.gameViewError === undefined
    ? {}
    : { error: record.gameViewError }),
});

const gameViewPresentation = (
  host: DesktopGameHostRecord,
  record: DesktopGameViewRecord,
): GameViewPresentation => ({
  active: host.selected === record,
  layout: host.layout,
  tiled: record.boundsLayout === "grid",
  windowActive: host.window.isFocused(),
});

const gameGroupControlsBounds = (
  width: number,
  height: number,
  topInset: number,
): {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
} => {
  const availableWidth = Math.max(1, width - GAME_GROUP_CONTROLS_MARGIN * 2);
  const availableHeight = Math.max(
    1,
    height - topInset - GAME_GROUP_CONTROLS_MARGIN * 2,
  );
  const panelWidth = Math.min(GAME_GROUP_CONTROLS_WIDTH, availableWidth);
  const panelHeight = Math.min(GAME_GROUP_CONTROLS_HEIGHT, availableHeight);
  return {
    height: panelHeight,
    width: panelWidth,
    x: Math.max(
      GAME_GROUP_CONTROLS_MARGIN,
      width - panelWidth - GAME_GROUP_CONTROLS_MARGIN,
    ),
    y: topInset + GAME_GROUP_CONTROLS_MARGIN,
  };
};

const setGameViewBounds = (
  view: ElectronGameViewHandle,
  bounds: ReturnType<typeof focusedGameViewBounds>,
): void => {
  const current = view.getBounds();
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  ) {
    view.setBounds(bounds);
  }
};

const cancelResize = (host: DesktopGameHostRecord): void => {
  if (host.resizeSettleTimer === undefined) return;
  clearTimeout(host.resizeSettleTimer);
  delete host.resizeSettleTimer;
};

const setShortcutModifierPressed = (
  host: DesktopGameHostRecord,
  pressed: boolean,
): void => {
  if (host.shortcutModifierPressed === pressed) return;
  host.shortcutModifierPressed = pressed;
  send(host.hostView, GameViewsIpc.shortcutModifierChanged, pressed);
};

const send = <Payload>(
  view: ElectronGameViewHandle,
  descriptor: IpcEventDescriptor<Payload>,
  payload: Payload,
): void => {
  if (!view.webContents.isDestroyed())
    view.webContents.send(
      descriptor.channel,
      descriptor.encodePayload(payload),
    );
};

export const makeDesktopGameHosts = (options: DesktopGameHostsOptions) => {
  const runSync = Effect.runSyncWith(
    Fiber.getCurrent()?.context ?? Context.empty(),
  );
  const state = (host: DesktopGameHostRecord): GameViewHostState => ({
    capacity: MAX_GAME_VIEWS_PER_WINDOW,
    groupControlsOpen: host.groupControlsOpen,
    groupTargetIds: host.tabs
      .filter((record) => host.groupTargets.has(record))
      .map((record) => String(record.rendererId)),
    layout: host.layout,
    selectedId: String(host.selected.rendererId),
    sessions: host.tabs.map(gameViewSession),
  });

  const applyGroupControlsLayout = (
    host: DesktopGameHostRecord,
    width: number,
    height: number,
    topInset: number,
  ): void => {
    if (!host.groupControlsOpen) return;
    setGameViewBounds(
      host.groupControlsView,
      gameGroupControlsBounds(width, height, topInset),
    );
    host.window.contentView.addChildView(host.groupControlsView.native);
  };

  const applyHostViewLayout = (
    host: DesktopGameHostRecord,
    width: number,
    height: number,
    topInset: number,
  ): void => {
    setGameViewBounds(host.hostView, {
      height: host.tabMenuOpen ? Math.max(1, height) : topInset,
      width: Math.max(1, width),
      x: 0,
      y: 0,
    });
    host.window.contentView.addChildView(host.hostView.native);
  };

  const applyLayout = (host: DesktopGameHostRecord): void => {
    const { height, width } = host.window.getContentBounds();
    const topInset = scaledGameViewTabBarHeight(
      host.hostView.webContents.getZoomFactor(),
    );
    if (host.layout === "focused") {
      host.selected.boundsLayout = "focused";
      if (host.stacked !== host.selected) {
        host.window.contentView.addChildView(host.selected.gameView.native);
        host.stacked = host.selected;
      }
    } else {
      for (const record of host.tabs) record.boundsLayout = "grid";
    }

    // Inactive views keep their last size behind the selected view, and a
    // hidden tile keeps its bounds until the grid shows it. A resized view
    // redraws everything at its new size, and views resized together compete
    // for the GPU.
    const focusedBounds = focusedGameViewBounds(width, height, topInset);
    for (const [index, record] of host.tabs.entries()) {
      if (host.layout === "focused" && record.boundsLayout === "grid") continue;
      setGameViewBounds(
        record.gameView,
        record.boundsLayout === "focused"
          ? focusedBounds
          : gridGameViewBounds(
              width,
              height,
              topInset,
              index,
              host.tabs.length,
            ),
      );
    }

    applyGroupControlsLayout(host, width, height, topInset);
    applyHostViewLayout(host, width, height, topInset);
    publishPresentations(host);
  };

  const isClosing = (host: DesktopGameHostRecord): boolean =>
    host.scope.state._tag === "Closed" ||
    host.nativeCloseRequested === true ||
    host.window.isDestroyed();

  const finishResize = (host: DesktopGameHostRecord): void => {
    cancelResize(host);
    if (isClosing(host)) return;

    try {
      applyLayout(host);
    } catch (cause) {
      if (isClosing(host)) return;
      runSync(
        logFailure("Failed to lay out game views", Cause.die(cause)).pipe(
          Effect.annotateLogs({
            component: "window",
            data: { hostRendererId: host.rendererId },
            repeatKey: String(host.rendererId),
          }),
        ),
      );
    }
  };

  const scheduleResize = (host: DesktopGameHostRecord): void => {
    if (host.scope.state._tag === "Closed" || host.nativeCloseRequested) return;

    if (host.resizeSettleTimer !== undefined) {
      clearTimeout(host.resizeSettleTimer);
    }
    // Some window managers omit Electron's `resized` event.
    host.resizeSettleTimer = setTimeout(
      () => finishResize(host),
      GAME_VIEW_RESIZE_SETTLE_DELAY_MS,
    );
  };

  const presentation = (
    host: DesktopGameHostRecord,
    record: DesktopGameViewRecord,
  ): GameViewPresentation => gameViewPresentation(host, record);

  const publishPresentations = (host: DesktopGameHostRecord): void => {
    for (const record of host.tabs) {
      const nextPresentation = presentation(host, record);
      if (
        record.publishedPresentation !== undefined &&
        sameGameViewPresentation(record.publishedPresentation, nextPresentation)
      ) {
        continue;
      }
      record.publishedPresentation = nextPresentation;
      send(record.gameView, GameViewsIpc.presentationChanged, nextPresentation);
    }
  };

  const publishState = (host: DesktopGameHostRecord): void => {
    const nextState = state(host);
    send(host.hostView, GameViewsIpc.changed, nextState);
    send(host.groupControlsView, GameViewsIpc.changed, nextState);
    publishPresentations(host);
    options.onStateChanged(host);
  };

  const refresh = (host: DesktopGameHostRecord): void => {
    cancelResize(host);
    applyLayout(host);
    publishState(host);
  };

  const activate = (
    host: DesktopGameHostRecord,
    record: DesktopGameViewRecord,
  ): void => {
    if (host.selected === record) return;
    host.selected = record;
    publishState(host);
  };

  const setTabMenuOpen = (host: DesktopGameHostRecord, open: boolean): void => {
    if (host.tabMenuOpen === open) return;
    const previousOpen = host.tabMenuOpen;
    host.tabMenuOpen = open;
    try {
      applyLayout(host);
    } catch (cause) {
      host.tabMenuOpen = previousOpen;
      try {
        applyLayout(host);
      } catch {}
      throw cause;
    }
    if (open) {
      try {
        host.hostView.webContents.focus();
      } catch {}
    }
    send(host.hostView, GameViewsIpc.tabMenuOpenChanged, host.tabMenuOpen);
  };

  const setGroupControlsOpen = (
    host: DesktopGameHostRecord,
    open: boolean,
  ): void => {
    if (host.groupControlsOpen === open) return;
    if (open && host.tabMenuOpen) setTabMenuOpen(host, false);
    if (open) {
      host.window.contentView.addChildView(host.groupControlsView.native);
    } else {
      host.window.contentView.removeChildView(host.groupControlsView.native);
    }
    host.groupControlsOpen = open;
    if (!open) delete host.stacked;
    refresh(host);
    if (open) {
      host.groupControlsView.webContents.focus();
    } else {
      host.selected.gameView.webContents.focus();
    }
  };

  const select = (
    host: DesktopGameHostRecord,
    id: number,
    focus: GameViewSelectionFocus,
  ): void => {
    const record = host.tabs.find((record) => record.rendererId === id);
    if (record === undefined) {
      throw new Error(`Game view does not belong to this host: ${id}`);
    }

    if (host.selected !== record || host.layout !== "focused") {
      host.selected = record;
      host.layout = "focused";
      refresh(host);
    }
    if (focus === "host") {
      host.hostView.webContents.focus();
    } else {
      record.gameView.webContents.focus();
    }
  };

  const focus = (host: DesktopGameHostRecord, id: number): void =>
    select(host, id, "view");

  const makeShortcutInputListener =
    (
      host: DesktopGameHostRecord,
    ): ((event: ElectronEvent, input: Input) => void) =>
    (event, input) => {
      const modifierHintUpdate = readGameViewShortcutModifierHintUpdate(
        input,
        options.platform,
      );
      if (modifierHintUpdate !== null) {
        setShortcutModifierPressed(host, modifierHintUpdate);
      }

      const index = readGameViewShortcutIndex(
        input,
        options.platform,
        host.tabs.length,
      );
      if (index === null) return;
      const record = host.tabs[index];
      if (record === undefined) return;

      event.preventDefault();
      focus(host, record.rendererId);
    };

  return {
    activate,
    cancelResize,
    finishResize,
    focus,
    makeShortcutInputListener,
    presentation,
    publishPresentations,
    publishState,
    refresh,
    scheduleResize,
    select,
    setGroupControlsOpen,
    setShortcutModifierPressed,
    setTabMenuOpen,
    syncTabBarLayout: applyLayout,
    state,
  };
};
