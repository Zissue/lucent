import * as Effect from "effect/Effect";

import {
  isValidGameViewGroupTargetSnapshot,
  resolveGameViewGroupTargets,
  type GameViewGroupCommand,
  type GameViewGroupCommandEnvelope,
} from "../../../shared/gameViews";
import { GameViewsIpc } from "../../../shared/ipc";
import { ElectronDialog } from "../../electron/ElectronDialog";
import { Accounts } from "../../internal/accounts/Accounts";
import { AccountSessions } from "../../internal/accounts/AccountSessions";
import { DesktopScriptLibrary } from "../../scripting/DesktopScriptLibrary";
import { parseGameViewTabId } from "../../window/DesktopGameHost";
import {
  DesktopWindowError,
  DesktopWindows,
  type GameViewHostChange,
  requireRenderer,
} from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";

const hostSenders = ["game-group-controls", "game-host"] as const;
const gameHostSenders = ["game-host"] as const;
const gameSenders = ["game"] as const;
const GROUP_LOGIN_STAGGER_MS = 650;

const confirmClose = Effect.fn("desktop.ipc.gameViews.confirmClose")(function* (
  rendererId: number,
) {
  const sessions = yield* AccountSessions;
  const session = sessions
    .snapshot()
    .find((entry) => entry.gameWindowId === rendererId);
  if (
    session?.script.state !== "running" &&
    session?.script.state !== "starting"
  )
    return true;
  const dialog = yield* ElectronDialog;
  const windows = yield* DesktopWindows;
  const { windowId: parentWindowId } = yield* requireRenderer(
    windows,
    rendererId,
  );
  const result = yield* dialog.showMessageBox(
    {
      type: "question",
      title: "Close tab",
      message: "A script is running in this tab.",
      detail: "Closing the tab will stop the script.",
      buttons: ["Keep open", "Stop script and close"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
    parentWindowId,
  );
  return result.response === 1;
});

const updateHost = (rendererId: number, change: GameViewHostChange) =>
  Effect.flatMap(DesktopWindows, (windows) =>
    windows.updateGameViewHost(rendererId, change),
  );

export const getRecentlyClosed = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.getRecentlyClosed,
  allowedSenders: gameHostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.getRecentlyClosed")(
    function* (_payload, sender) {
      const accounts = yield* Accounts;
      const windows = yield* DesktopWindows;
      const { windowId: groupId } = yield* requireRenderer(
        windows,
        sender.rendererId,
      );
      return yield* accounts.getRecentlyClosed(groupId);
    },
  ),
});

export const reopen = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.reopen,
  allowedSenders: gameHostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.reopen")(function* (
    { id },
    sender,
  ) {
    const windows = yield* DesktopWindows;
    const accounts = yield* Accounts;
    const state = yield* windows.getGameViewHostState(sender.rendererId);
    if (state.sessions.length >= state.capacity) {
      return yield* new DesktopWindowError({
        id: String(sender.rendererId),
        detail: "Close a tab before reopening another.",
      });
    }
    const gameWindowId = parseGameViewTabId(state.selectedId);
    const { windowId: gameWindowGroupId } = yield* requireRenderer(
      windows,
      sender.rendererId,
    );
    yield* accounts.reopenGameWindow({
      id,
      gameWindowGroupId,
      windowTarget: { kind: "same-as-game", gameWindowId },
    });
    return yield* windows.getGameViewHostState(sender.rendererId);
  }),
});

export const getState = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.getState,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.getState")(
    function* (_payload, sender) {
      const windows = yield* DesktopWindows;
      return yield* windows.getGameViewHostState(sender.rendererId);
    },
  ),
});

export const add = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.add,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.add")(function* (_payload, sender) {
    const windows = yield* DesktopWindows;
    return yield* windows.addGameView(sender.rendererId);
  }),
});

export const select = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.select,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.select")((payload, sender) =>
    updateHost(sender.rendererId, {
      type: "select",
      id: parseGameViewTabId(payload.id),
      focus: payload.focus,
    }),
  ),
});

export const close = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.close,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.close")(
    function* (payload, sender) {
      const windows = yield* DesktopWindows;
      const state = yield* windows.getGameViewHostState(sender.rendererId);
      if (!state.sessions.some((session) => session.id === payload.id)) {
        return yield* new DesktopWindowError({
          id: payload.id,
          detail: "This tab no longer belongs to this window.",
        });
      }
      const rendererId = parseGameViewTabId(payload.id);
      if (!(yield* confirmClose(rendererId))) return;
      return yield* windows.closeGameView(sender.rendererId, rendererId);
    },
  ),
});

export const reorder = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.reorder,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.reorder")((payload, sender) =>
    updateHost(sender.rendererId, {
      type: "reorder",
      ids: payload.ids.map(parseGameViewTabId),
    }),
  ),
});

export const setLayout = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.setLayout,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.setLayout")((payload, sender) =>
    updateHost(sender.rendererId, {
      type: "layout",
      layout: payload.layout,
    }),
  ),
});

export const setGroupControlsOpen = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.setGroupControlsOpen,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.setGroupControlsOpen")(
    (payload, sender) =>
      updateHost(sender.rendererId, {
        type: "group-controls",
        open: payload.open,
      }),
  ),
});

export const setTabMenuOpen = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.setTabMenuOpen,
  allowedSenders: gameHostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.setTabMenuOpen")(
    (payload, sender) =>
      updateHost(sender.rendererId, {
        type: "tab-menu",
        open: payload.open,
      }).pipe(Effect.as(payload.open)),
  ),
});

export const syncTabBarLayout = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.syncTabBarLayout,
  allowedSenders: gameHostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.syncTabBarLayout")(
    (_payload, sender) =>
      updateHost(sender.rendererId, {
        type: "tab-bar-layout",
      }).pipe(Effect.asVoid),
  ),
});

export const setGroupTargets = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.setGroupTargets,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.setGroupTargets")(
    (payload, sender) =>
      updateHost(sender.rendererId, {
        type: "group-targets",
        ids: payload.ids.map(parseGameViewTabId),
      }),
  ),
});

export const dispatchGroupCommand = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.dispatchGroupCommand,
  allowedSenders: hostSenders,
  handler: Effect.fn("desktop.ipc.gameViews.dispatchGroupCommand")(
    function* (request, sender) {
      const ipc = yield* DesktopIpc;
      const windows = yield* DesktopWindows;
      const state = yield* windows.getGameViewHostState(sender.rendererId);
      if (!isValidGameViewGroupTargetSnapshot(state, request.targetIds)) {
        return yield* new DesktopWindowError({
          detail:
            "Group command targets must be unique tabs in this game window.",
          id: String(sender.rendererId),
        });
      }
      let { readySessions, skippedCount } = resolveGameViewGroupTargets(
        state,
        request.targetIds,
      );
      let rendererIds = readySessions.map((session) =>
        parseGameViewTabId(session.id),
      );

      if (rendererIds.length === 0) {
        return {
          recipientCount: 0,
          skippedCount,
          status: "sent" as const,
        };
      }

      let command: GameViewGroupCommand;
      if (request.command.kind === "load-script") {
        const scripts = yield* DesktopScriptLibrary;
        const result = yield* windows.withGameViewGroupControlsNativeDialog(
          sender.rendererId,
          (parentWindowId) => scripts.openFile(parentWindowId),
        );
        if (result.canceled) {
          return {
            recipientCount: 0,
            skippedCount,
            status: "canceled" as const,
          };
        }
        command = { file: result.file, kind: "load-script" };

        // Native file selection can outlive a tab or renderer generation.
        // Re-resolve the captured target IDs immediately before delivery.
        const latestState = yield* windows.getGameViewHostState(
          sender.rendererId,
        );
        ({ readySessions, skippedCount } = resolveGameViewGroupTargets(
          latestState,
          request.targetIds,
        ));
        rendererIds = readySessions.map((session) =>
          parseGameViewTabId(session.id),
        );
        if (rendererIds.length === 0) {
          return {
            recipientCount: 0,
            skippedCount,
            status: "sent" as const,
          };
        }
      } else {
        command = request.command;
      }

      if (command.kind === "login") {
        // Queue every login immediately while spacing network submissions
        // enough to avoid tripping AQW's multi-login rate limiting.
        yield* Effect.forEach(
          rendererIds,
          (rendererId, index) => {
            const envelope: GameViewGroupCommandEnvelope = {
              command,
              delayMs: index * GROUP_LOGIN_STAGGER_MS,
            };
            return ipc.sendToRendererIds(
              [rendererId],
              GameViewsIpc.groupCommand,
              envelope,
            );
          },
          { discard: true },
        );
      } else {
        const envelope: GameViewGroupCommandEnvelope = {
          command,
          delayMs: 0,
        };
        yield* ipc.sendToRendererIds(
          rendererIds,
          GameViewsIpc.groupCommand,
          envelope,
        );
      }

      return {
        recipientCount: rendererIds.length,
        skippedCount,
        status: "sent" as const,
      };
    },
  ),
});

export const dispatchGroupOptionHotkey = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.dispatchGroupOptionHotkey,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.gameViews.dispatchGroupOptionHotkey")(
    function* ({ commandId }, sender) {
      const ipc = yield* DesktopIpc;
      const windows = yield* DesktopWindows;
      const state = yield* windows.getGameViewHostState(sender.rendererId);
      if (state.layout !== "grid") {
        return {
          recipientCount: 0,
          skippedCount: 0,
          status: "sent" as const,
        };
      }

      const { readySessions, skippedCount } = resolveGameViewGroupTargets(
        state,
        state.groupTargetIds,
      );
      const rendererIds = readySessions.map((session) =>
        parseGameViewTabId(session.id),
      );
      if (rendererIds.length > 0) {
        const envelope: GameViewGroupCommandEnvelope = {
          command: { commandId, kind: "run-option-hotkey" },
          delayMs: 0,
        };
        yield* ipc.sendToRendererIds(
          rendererIds,
          GameViewsIpc.groupCommand,
          envelope,
        );
      }

      return {
        recipientCount: rendererIds.length,
        skippedCount,
        status: "sent" as const,
      };
    },
  ),
});

export const getPresentation = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.getPresentation,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.gameViews.getPresentation")(
    function* (_payload, sender) {
      const windows = yield* DesktopWindows;
      return yield* windows.getGameViewPresentation(sender.rendererId);
    },
  ),
});

export const closeCurrent = makeDesktopIpcMethod({
  descriptor: GameViewsIpc.closeCurrent,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.gameViews.closeCurrent")(
    function* (_payload, sender) {
      const windows = yield* DesktopWindows;
      yield* windows.closeRenderer(sender.rendererId);
    },
  ),
});

export const methods = [
  getRecentlyClosed,
  reopen,
  getState,
  add,
  select,
  close,
  reorder,
  setLayout,
  setGroupTargets,
  setGroupControlsOpen,
  setTabMenuOpen,
  syncTabBarLayout,
  dispatchGroupCommand,
  dispatchGroupOptionHotkey,
  getPresentation,
  closeCurrent,
] as const;
