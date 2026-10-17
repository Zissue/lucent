import {
  createIdleFollowerState,
  normalizeFollowerState,
  type FollowerConfig,
  type FollowerState,
} from "@lucent/core/follower";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import {
  FollowerIpc,
  type FollowerPlayers,
} from "../../../shared/ipc/follower";
import { DesktopIpc } from "../../ipc/DesktopIpc";
import { DesktopWindows } from "../../window/DesktopWindows";
import {
  GameRendererRpc,
  type GameRendererRpcClient,
} from "../rpc/GameRendererRpc";

export const FOLLOWER_COMMAND_TIMEOUT_MS = 5_000;

export class GameFollowerRequestError extends Schema.TaggedError<GameFollowerRequestError>()(
  "GameFollowerRequestError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface FollowerPlayersUpdate {
  readonly changed: boolean;
  readonly players: FollowerPlayers;
}

type FollowerRequest<A> = Effect.Effect<A, GameFollowerRequestError>;

export interface GameFollowersShape {
  readonly configure: (
    gameRendererId: number,
    config: FollowerConfig,
  ) => FollowerRequest<FollowerState>;
  readonly getConfig: (
    gameRendererId: number,
  ) => Effect.Effect<FollowerConfig | null>;
  readonly get: (gameRendererId: number) => Effect.Effect<FollowerState>;
  readonly getPlayers: (
    gameRendererId: number,
  ) => Effect.Effect<FollowerPlayers>;
  readonly me: (gameRendererId: number) => FollowerRequest<string>;
  readonly remove: (gameRendererId: number) => Effect.Effect<void>;
  readonly fetchState: (
    gameRendererId: number,
  ) => FollowerRequest<FollowerState>;
  readonly set: (
    gameRendererId: number,
    state: FollowerState,
  ) => Effect.Effect<FollowerState>;
  readonly setPlayers: (
    gameRendererId: number,
    players: FollowerPlayers,
  ) => Effect.Effect<FollowerPlayersUpdate>;
  readonly start: (
    gameRendererId: number,
    config: FollowerConfig,
  ) => FollowerRequest<FollowerState>;
  readonly stop: (gameRendererId: number) => FollowerRequest<FollowerState>;
}

export class GameFollowers extends Context.Service<
  GameFollowers,
  GameFollowersShape
>()("lucent/internal/follower/GameFollowers") {}

export const makeGameFollowers = Effect.gen(function* () {
  const ipc = yield* DesktopIpc;
  const rpc = yield* GameRendererRpc;
  const windows = yield* DesktopWindows;
  const states = new Map<number, FollowerState>();
  // Desired configuration survives renderer generations and is reconciled on ready.
  const configs = new Map<number, FollowerConfig>();
  const playersByGame = new Map<number, FollowerPlayers>();

  const request = <A>(
    gameRendererId: number,
    send: (client: GameRendererRpcClient) => Effect.Effect<A, RpcClientError>,
  ): FollowerRequest<A> =>
    rpc
      .call(gameRendererId, send, { timeout: FOLLOWER_COMMAND_TIMEOUT_MS })
      .pipe(
        Effect.catchTag("GameRendererUnavailableError", (error) =>
          Effect.fail(new GameFollowerRequestError({ detail: error.detail })),
        ),
      );

  const requestState = (
    gameRendererId: number,
    send: (
      client: GameRendererRpcClient,
    ) => Effect.Effect<FollowerState, RpcClientError>,
  ) =>
    request(gameRendererId, send).pipe(
      Effect.flatMap((state) => set(gameRendererId, state)),
    );

  const requestConfigured = (
    gameRendererId: number,
    config: FollowerConfig,
    send: (
      client: GameRendererRpcClient,
    ) => Effect.Effect<FollowerState, RpcClientError>,
  ) =>
    Effect.suspend(() => {
      configs.set(gameRendererId, config);
      return requestState(gameRendererId, send);
    });

  const configure: GameFollowersShape["configure"] = (gameRendererId, config) =>
    requestConfigured(gameRendererId, config, (client) =>
      client.FollowerConfigure(config),
    );

  const start: GameFollowersShape["start"] = (gameRendererId, config) =>
    requestConfigured(gameRendererId, config, (client) =>
      client.FollowerStart(config),
    );

  const stop: GameFollowersShape["stop"] = (gameRendererId) =>
    requestState(gameRendererId, (client) => client.FollowerStop());

  const fetchState: GameFollowersShape["fetchState"] = (gameRendererId) =>
    requestState(gameRendererId, (client) => client.FollowerGetState());

  const me: GameFollowersShape["me"] = (gameRendererId) =>
    request(gameRendererId, (client) => client.FollowerMe());

  const get: GameFollowersShape["get"] = (gameRendererId) =>
    windows
      .describe(gameRendererId)
      .pipe(
        Effect.map((info) =>
          info?.ready
            ? normalizeFollowerState(
                states.get(gameRendererId) ?? createIdleFollowerState(),
              )
            : createIdleFollowerState(),
        ),
      );

  const getConfig: GameFollowersShape["getConfig"] = (gameRendererId) =>
    Effect.sync(() => configs.get(gameRendererId) ?? null);

  const set: GameFollowersShape["set"] = (gameRendererId, state) =>
    Effect.sync(() => {
      const normalized = normalizeFollowerState(state);
      states.set(gameRendererId, normalized);
      return normalized;
    });

  const getPlayers: GameFollowersShape["getPlayers"] = (gameRendererId) =>
    windows
      .describe(gameRendererId)
      .pipe(
        Effect.map((info) =>
          info?.ready ? (playersByGame.get(gameRendererId) ?? []) : [],
        ),
      );

  const setPlayers: GameFollowersShape["setPlayers"] = (
    gameRendererId,
    incoming,
  ) =>
    Effect.sync(() => {
      const current = playersByGame.get(gameRendererId);
      const players = [...incoming];
      const changed =
        current === undefined ||
        current.length !== players.length ||
        current.some((player, index) => player !== players[index]);
      if (changed) {
        playersByGame.set(gameRendererId, players);
      }
      return {
        changed,
        players: changed ? players : current,
      };
    });

  const invalidate = (gameRendererId: number) =>
    Effect.gen(function* () {
      states.delete(gameRendererId);
      playersByGame.delete(gameRendererId);
      const targets = yield* windows
        .getOwnedRendererIds(gameRendererId, "follower")
        .pipe(Effect.orElseSucceed(() => []));
      yield* Effect.all([
        ipc.sendToRendererIds(
          targets,
          FollowerIpc.changed,
          createIdleFollowerState(),
        ),
        ipc.sendToRendererIds(targets, FollowerIpc.playersChanged, []),
      ]);
    });

  const remove: GameFollowersShape["remove"] = (gameRendererId) =>
    invalidate(gameRendererId).pipe(
      Effect.andThen(Effect.sync(() => configs.delete(gameRendererId))),
      Effect.asVoid,
    );

  const reconcile = Effect.fn("GameFollowers.reconcile")(function* (
    gameRendererId: number,
  ) {
    const config = configs.get(gameRendererId);
    if (config === undefined) {
      return;
    }

    const state = yield* configure(gameRendererId, config);
    const targets = yield* windows
      .getOwnedRendererIds(gameRendererId, "follower")
      .pipe(Effect.orElseSucceed(() => []));
    yield* ipc.sendToRendererIds(targets, FollowerIpc.changed, state);
  });

  yield* windows.observe({ kind: "game" }, (event) => {
    switch (event.type) {
      case "closed":
        return remove(event.rendererId);
      case "crashed":
      case "reloaded":
        return invalidate(event.rendererId);
      default:
        return Effect.void;
    }
  });
  yield* Effect.acquireRelease(
    rpc.onConnected((gameRendererId) =>
      reconcile(gameRendererId).pipe(Effect.ignore),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return GameFollowers.of({
    configure,
    getConfig,
    get,
    getPlayers,
    me,
    remove,
    fetchState,
    set,
    setPlayers,
    start,
    stop,
  });
});

export const layer = Layer.effect(GameFollowers, makeGameFollowers);
