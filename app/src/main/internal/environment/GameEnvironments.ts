import {
  createEmptyEnvironmentState,
  normalizeEnvironmentState,
  type EnvironmentState,
} from "@lucent/core/environment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { EnvironmentBoostDiscovery } from "../../../shared/environmentBoosts";
import { GameRendererRpc } from "../game-renderer/GameRendererRpc";
import { DesktopWindows } from "../../window/DesktopWindows";

export const ENVIRONMENT_BOOST_FETCH_TIMEOUT_MS = 12_000;
export const ENVIRONMENT_BOOST_WITHDRAW_BASE_TIMEOUT_MS = 15_000;
export const ENVIRONMENT_BOOST_WITHDRAW_ITEM_TIMEOUT_MS = 6_000;

const emptyBoostDiscovery = (): EnvironmentBoostDiscovery => ({
  bank: [],
  bankLoaded: false,
  inventory: [],
});

export interface GameEnvironmentsShape {
  readonly fetchBoosts: (
    gameRendererId: number,
  ) => Effect.Effect<EnvironmentBoostDiscovery>;
  readonly get: (gameRendererId: number) => Effect.Effect<EnvironmentState>;
  readonly remove: (gameRendererId: number) => Effect.Effect<void>;
  readonly set: (
    gameRendererId: number,
    state: EnvironmentState,
  ) => Effect.Effect<EnvironmentState>;
  readonly update: (
    gameRendererId: number,
    reducer: (state: EnvironmentState) => EnvironmentState,
  ) => Effect.Effect<EnvironmentState>;
  readonly withdrawBoosts: (
    gameRendererId: number,
    itemIds: readonly number[],
  ) => Effect.Effect<readonly number[]>;
}

export class GameEnvironments extends Context.Service<
  GameEnvironments,
  GameEnvironmentsShape
>()("lucent/internal/environment/GameEnvironments") {}

export const makeGameEnvironments = Effect.gen(function* () {
  const rpc = yield* GameRendererRpc;
  const windows = yield* DesktopWindows;
  const states = new Map<number, EnvironmentState>();

  const get: GameEnvironmentsShape["get"] = (gameRendererId) =>
    Effect.sync(() => {
      const state = states.get(gameRendererId) ?? createEmptyEnvironmentState();
      const normalized = normalizeEnvironmentState(state);
      states.set(gameRendererId, normalized);
      return normalized;
    });

  const set: GameEnvironmentsShape["set"] = (gameRendererId, state) =>
    Effect.sync(() => {
      const normalized = normalizeEnvironmentState(state);
      states.set(gameRendererId, normalized);
      return normalized;
    });

  const update: GameEnvironmentsShape["update"] = (gameRendererId, reducer) =>
    Effect.sync(() => {
      const current =
        states.get(gameRendererId) ?? createEmptyEnvironmentState();
      const next = normalizeEnvironmentState(reducer(current));
      states.set(gameRendererId, next);
      return next;
    });

  const remove: GameEnvironmentsShape["remove"] = (gameRendererId) =>
    Effect.sync(() => {
      states.delete(gameRendererId);
    });

  const fetchBoosts: GameEnvironmentsShape["fetchBoosts"] = (gameRendererId) =>
    rpc
      .call(gameRendererId, (client) => client.EnvironmentFetchBoosts(), {
        timeout: ENVIRONMENT_BOOST_FETCH_TIMEOUT_MS,
      })
      .pipe(Effect.catchCause(() => Effect.succeed(emptyBoostDiscovery())));

  const withdrawBoosts: GameEnvironmentsShape["withdrawBoosts"] = (
    gameRendererId,
    itemIds,
  ) => {
    const uniqueItemIds = Array.from(new Set(itemIds));
    if (uniqueItemIds.length === 0) {
      return Effect.succeed([]);
    }
    return rpc
      .call(
        gameRendererId,
        (client) =>
          client.EnvironmentWithdrawBoosts({ itemIds: uniqueItemIds }),
        {
          timeout:
            ENVIRONMENT_BOOST_WITHDRAW_BASE_TIMEOUT_MS +
            ENVIRONMENT_BOOST_WITHDRAW_ITEM_TIMEOUT_MS * uniqueItemIds.length,
        },
      )
      .pipe(Effect.catchCause(() => Effect.succeed([])));
  };

  yield* windows.observe({ kind: "game" }, (event) =>
    event.type === "closed" ? remove(event.rendererId) : Effect.void,
  );

  return GameEnvironments.of({
    fetchBoosts,
    get,
    remove,
    set,
    update,
    withdrawBoosts,
  });
});

export const layer = Layer.effect(GameEnvironments, makeGameEnvironments);
