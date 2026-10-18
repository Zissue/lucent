import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
    "reports boost request failures when the game renderer is unavailable",
    () =>
      Effect.gen(function* () {
        const { environments } = yield* makeEnvironments();

        const expected = {
          _tag: "GameRendererUnavailableError",
          reason: "loading",
          detail: "The game is still loading. Try again in a moment.",
        };
        expect(
          yield* environments
            .fetchBoosts(TEST_GAME_RENDERER_ID)
            .pipe(Effect.flip),
        ).toMatchObject(expected);
        expect(
          yield* environments
            .withdrawBoosts(TEST_GAME_RENDERER_ID, [3])
            .pipe(Effect.flip),
        ).toMatchObject(expected);
      }),
  );

  it.effect.each(["fetch", "withdraw"] as const)(
    "reports a timeout when the renderer does not answer a boost %s request",
    (operation) =>
      Effect.gen(function* () {
        const { environments, game } = yield* makeEnvironments({
          EnvironmentFetchBoosts: () => Effect.never,
          EnvironmentWithdrawBoosts: () => Effect.never,
        });
        yield* game.ready;

        const fetch = yield* Effect.forkScoped(
          (operation === "fetch"
            ? environments
                .fetchBoosts(TEST_GAME_RENDERER_ID)
                .pipe(Effect.asVoid)
            : environments
                .withdrawBoosts(TEST_GAME_RENDERER_ID, [3])
                .pipe(Effect.asVoid)
          ).pipe(Effect.flip),
        );
        yield* TestClock.adjust(
          operation === "fetch" ? "12 seconds" : "21 seconds",
        );

        expect(yield* Fiber.join(fetch)).toMatchObject({
          _tag: "GameRendererUnavailableError",
          reason: "timeout",
          detail: "The game did not respond in time. Try again.",
        });
      }),
  );

  it.effect.each(["fetch", "withdraw"] as const)(
    "reports a disconnect during a boost %s request",
    (operation) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const handler = () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        const { environments, game } = yield* makeEnvironments({
          EnvironmentFetchBoosts: handler,
          EnvironmentWithdrawBoosts: handler,
        });
        yield* game.ready;
        const request = yield* (
          operation === "fetch"
            ? environments
                .fetchBoosts(TEST_GAME_RENDERER_ID)
                .pipe(Effect.asVoid)
            : environments
                .withdrawBoosts(TEST_GAME_RENDERER_ID, [3])
                .pipe(Effect.asVoid)
        ).pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(started);
        yield* game.reload;

        expect(yield* Fiber.join(request)).toMatchObject({
          _tag: "GameRendererUnavailableError",
          reason: "disconnected",
          detail: "The connection was unavailable.",
        });
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
      expect(
        yield* environments.withdrawBoosts(TEST_GAME_RENDERER_ID, []),
      ).toEqual([]);
      expect(requested).toEqual([[3, 2]]);
    }),
  );
});
