import {
  normalizeFollowerConfig,
  type FollowerState,
} from "@lucent/core/follower";
import * as Effect from "effect/Effect";

import { FollowerIpc } from "../../../shared/ipc";
import { GameFollowers } from "../../internal/follower/GameFollowers";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";
import {
  resolveGameRendererId,
  type DesktopIpcSender,
} from "../DesktopIpcSenders";

const notifyChanged = Effect.fn("desktop.ipc.follower.notifyChanged")(
  function* (
    gameRendererId: number,
    state: FollowerState,
    excludedRendererId?: number,
  ) {
    const ipc = yield* DesktopIpc;
    const windows = yield* DesktopWindows;
    const targets = (yield* windows.getOwnedRendererIds(
      gameRendererId,
      "follower",
    )).filter((rendererId) => rendererId !== excludedRendererId);
    yield* ipc.sendToRendererIds(targets, FollowerIpc.changed, state);
  },
);

const notifyPlayersChanged = Effect.fn(
  "desktop.ipc.follower.notifyPlayersChanged",
)(function* (gameRendererId: number, players: readonly string[]) {
  const ipc = yield* DesktopIpc;
  const windows = yield* DesktopWindows;
  const targets = yield* windows.getOwnedRendererIds(
    gameRendererId,
    "follower",
  );
  yield* ipc.sendToRendererIds(targets, FollowerIpc.playersChanged, players);
});

const requestAndNotify = Effect.fn("desktop.ipc.follower.requestAndNotify")(
  function* <E>(
    sender: DesktopIpcSender,
    request: (
      followers: GameFollowers["Service"],
      gameRendererId: number,
    ) => Effect.Effect<FollowerState, E>,
  ) {
    const followers = yield* GameFollowers;
    const gameRendererId = yield* resolveGameRendererId(sender);
    const state = yield* request(followers, gameRendererId);
    yield* notifyChanged(gameRendererId, state, sender.rendererId);
    return state;
  },
);

export const configure = makeDesktopIpcMethod({
  descriptor: FollowerIpc.configure,
  allowedSenders: ["follower"],
  handler: (payload, sender) =>
    requestAndNotify(sender, (followers, gameRendererId) =>
      followers.configure(gameRendererId, normalizeFollowerConfig(payload)),
    ),
});

export const getConfig = makeDesktopIpcMethod({
  descriptor: FollowerIpc.getConfig,
  allowedSenders: ["follower"],
  handler: Effect.fn("desktop.ipc.follower.getConfig")(
    function* (_payload, sender) {
      const followers = yield* GameFollowers;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* followers.getConfig(gameRendererId);
    },
  ),
});

export const getState = makeDesktopIpcMethod({
  descriptor: FollowerIpc.getState,
  allowedSenders: ["follower"],
  handler: Effect.fn("desktop.ipc.follower.getState")(
    function* (_payload, sender) {
      const followers = yield* GameFollowers;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* followers.fetchState(gameRendererId).pipe(
        Effect.tap((state) =>
          notifyChanged(gameRendererId, state, sender.rendererId),
        ),
        Effect.catchTag("GameFollowerRequestError", () =>
          followers.get(gameRendererId),
        ),
      );
    },
  ),
});

export const getPlayers = makeDesktopIpcMethod({
  descriptor: FollowerIpc.getPlayers,
  allowedSenders: ["follower"],
  handler: Effect.fn("desktop.ipc.follower.getPlayers")(
    function* (_payload, sender) {
      const followers = yield* GameFollowers;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* followers.getPlayers(gameRendererId);
    },
  ),
});

export const me = makeDesktopIpcMethod({
  descriptor: FollowerIpc.me,
  allowedSenders: ["follower"],
  handler: Effect.fn("desktop.ipc.follower.me")(function* (_payload, sender) {
    const followers = yield* GameFollowers;
    const gameRendererId = yield* resolveGameRendererId(sender);
    return yield* followers.me(gameRendererId);
  }),
});

export const start = makeDesktopIpcMethod({
  descriptor: FollowerIpc.start,
  allowedSenders: ["follower"],
  handler: (payload, sender) =>
    requestAndNotify(sender, (followers, gameRendererId) =>
      followers.start(gameRendererId, normalizeFollowerConfig(payload)),
    ),
});

export const stop = makeDesktopIpcMethod({
  descriptor: FollowerIpc.stop,
  allowedSenders: ["follower"],
  handler: (_payload, sender) =>
    requestAndNotify(sender, (followers, gameRendererId) =>
      followers.stop(gameRendererId),
    ),
});

export const publishState = makeDesktopIpcMethod({
  descriptor: FollowerIpc.publishState,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.follower.publishState")(
    function* (incoming, sender) {
      const followers = yield* GameFollowers;
      const state = yield* followers.set(sender.rendererId, incoming);
      yield* notifyChanged(sender.rendererId, state);
    },
  ),
});

export const publishPlayers = makeDesktopIpcMethod({
  descriptor: FollowerIpc.publishPlayers,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.follower.publishPlayers")(
    function* (incoming, sender) {
      const followers = yield* GameFollowers;
      const update = yield* followers.setPlayers(sender.rendererId, incoming);
      if (update.changed) {
        yield* notifyPlayersChanged(sender.rendererId, update.players);
      }
    },
  ),
});

export const methods = [
  configure,
  getConfig,
  getPlayers,
  getState,
  me,
  start,
  stop,
  publishPlayers,
  publishState,
] as const;
