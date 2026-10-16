import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AccountLaunchWindowTarget } from "@lucent/core/accounts";
import { ElectronSession } from "../electron/ElectronSession";
import {
  AccountGameWindows,
  type AccountGameWindowEvent,
} from "../internal/accounts/AccountGameWindows";
import {
  type DesktopGameHostTarget,
  DesktopWindows,
  requireRenderer,
} from "./DesktopWindows";

const resolveGameHostTarget = (
  target: AccountLaunchWindowTarget | undefined,
): DesktopGameHostTarget => {
  if (target === undefined) return { kind: "available" };
  return target.kind === "new"
    ? { kind: "new" }
    : { rendererId: target.gameWindowId, kind: "game-view" };
};

export const layer = Layer.effect(
  AccountGameWindows,
  Effect.gen(function* () {
    const windows = yield* DesktopWindows;
    const electronSession = yield* ElectronSession;

    const toAccountGameWindowEvent = Effect.fn(
      "DesktopAccountGameWindows.toAccountGameWindowEvent",
    )(function* (event: {
      readonly generation: number;
      readonly rendererId: number;
    }): Effect.fn.Return<AccountGameWindowEvent> {
      const gameWindowGroupId = (yield* windows.describe(event.rendererId))
        ?.windowId;
      return {
        ...(gameWindowGroupId === undefined ? {} : { gameWindowGroupId }),
        gameWindowId: event.rendererId,
        rendererGeneration: event.generation,
      };
    });

    const close: AccountGameWindows["Service"]["close"] = (gameWindowId) =>
      windows.closeRenderer(gameWindowId);

    const getGeneration: AccountGameWindows["Service"]["getGeneration"] = (
      gameWindowId,
    ) =>
      Effect.map(
        requireRenderer(windows, gameWindowId),
        (info) => info.generation,
      );

    const getGroupId: AccountGameWindows["Service"]["getGroupId"] = (
      gameWindowId,
    ) =>
      Effect.map(
        requireRenderer(windows, gameWindowId),
        (info) => info.windowId,
      );

    const onClosed: AccountGameWindows["Service"]["onClosed"] = (listener) =>
      windows.observe({ kind: "game" }, (event) =>
        event.type === "closed" ? listener(event.rendererId) : Effect.void,
      );

    const onCreated: AccountGameWindows["Service"]["onCreated"] = (listener) =>
      windows.observe({ kind: "game" }, (event) =>
        event.type === "created"
          ? toAccountGameWindowEvent(event).pipe(Effect.flatMap(listener))
          : Effect.void,
      );

    const onReloaded: AccountGameWindows["Service"]["onReloaded"] = (
      listener,
    ) =>
      windows.observe({ kind: "game" }, (event) =>
        event.type === "reloaded"
          ? toAccountGameWindowEvent(event).pipe(Effect.flatMap(listener))
          : Effect.void,
      );

    const open: AccountGameWindows["Service"]["open"] = (options) => {
      const onCreated = options?.onCreated;
      return windows.open("game", {
        gameHostTarget: resolveGameHostTarget(options?.windowTarget),
        ...(options?.managedProfileKey === undefined
          ? {}
          : { managedGameProfileKey: options.managedProfileKey }),
        ...(options?.name === undefined ? {} : { gameViewName: options.name }),
        ...(options?.gameViewLayout === undefined
          ? {}
          : { gameViewLayout: options.gameViewLayout }),
        ...(onCreated === undefined
          ? {}
          : {
              onCreated: (event) =>
                toAccountGameWindowEvent(event).pipe(Effect.flatMap(onCreated)),
            }),
      });
    };

    const reveal: AccountGameWindows["Service"]["reveal"] = (gameWindowId) =>
      windows.revealRenderer(gameWindowId);

    const retireProfile: AccountGameWindows["Service"]["retireProfile"] =
      electronSession.retireManagedGameProfile;

    const setName: AccountGameWindows["Service"]["setName"] = (
      gameWindowId,
      name,
    ) => windows.setGameViewName(gameWindowId, name);

    return AccountGameWindows.of({
      close,
      getGeneration,
      getGroupId,
      onClosed,
      onCreated,
      onReloaded,
      open,
      reveal,
      retireProfile,
      setName,
    });
  }),
);
