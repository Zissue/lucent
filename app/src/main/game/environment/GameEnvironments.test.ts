import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import type { EnvironmentBoostDiscovery } from "../../../shared/environmentBoosts";
import { DesktopWindows } from "../../window/DesktopWindows";
import { GameRendererRpc } from "../rpc/GameRendererRpc";
import {
  makeTestGameRenderer,
  TEST_GAME_RENDERER_ID,
  type GameRendererRpcHandlerMap,
} from "../rpc/GameRendererRpcTesting";
import { makeGameEnvironments } from "./GameEnvironments";

const emptyDiscovery: EnvironmentBoostDiscovery = {
  bank: [],
  bankLoaded: false,
  inventory: [],
};

const makeEnvironments = Effect.fn(function* (
  handlers: Partial<GameRendererRpcHandlerMap> = {},
) {
  const game = yield* makeTestGameRenderer(handlers);
  const environments = yield* makeGameEnvironments.pipe(
    Effect.provideService(DesktopWindows, game.windows),
    Effect.provideService(GameRendererRpc, game.rpc),
  );
  return { environments, game };
});

describe("GameEnvironments", () => {
  it.effect("returns boosts discovered by the game renderer", () =>
    Effect.gen(function* () {
      const discovery: EnvironmentBoostDiscovery = {
        bank: [{ itemId: 3, name: "Gold Boost", quantity: 1 }],
        bankLoaded: true,
        inventory: [],
      };
      const { environments, game } = yield* makeEnvironments({
        EnvironmentFetchBoosts: () => Effect.succeed(discovery),
      });
      yield* game.ready;

      expect(yield* environments.fetchBoosts(TEST_GAME_RENDERER_ID)).toEqual(
        discovery,
      );
    }),
  );

  it.effect(
    "falls back to empty boosts when the game renderer is unavailable",
    () =>
      Effect.gen(function* () {
        const { environments } = yield* makeEnvironments();

        expect(yield* environments.fetchBoosts(TEST_GAME_RENDERER_ID)).toEqual(
          emptyDiscovery,
        );
        expect(
          yield* environments.withdrawBoosts(TEST_GAME_RENDERER_ID, [3]),
        ).toEqual([]);
      }),
  );

  it.effect(
    "falls back to empty boosts when the game renderer does not answer",
    () =>
      Effect.gen(function* () {
        const { environments, game } = yield* makeEnvironments({
          EnvironmentFetchBoosts: () => Effect.never,
        });
        yield* game.ready;

        const fetch = yield* Effect.forkScoped(
          environments.fetchBoosts(TEST_GAME_RENDERER_ID),
        );
        yield* TestClock.adjust("12 seconds");

        expect(yield* Fiber.join(fetch)).toEqual(emptyDiscovery);
      }),
  );

  it.effect("withdraws each requested boost once", () =>
    Effect.gen(function* () {
      const requested: (readonly number[])[] = [];
      const { environments, game } = yield* makeEnvironments({
        EnvironmentWithdrawBoosts: ({ itemIds }) =>
          Effect.sync(() => {
            requested.push(itemIds);
            return itemIds;
          }),
      });
      yield* game.ready;

      expect(
        yield* environments.withdrawBoosts(TEST_GAME_RENDERER_ID, [3, 2, 3, 2]),
      ).toEqual([3, 2]);
      expect(requested).toEqual([[3, 2]]);
    }),
  );
});
