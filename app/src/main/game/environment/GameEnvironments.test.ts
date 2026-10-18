import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import type { EnvironmentBoostDiscovery } from "../../../shared/environmentBoosts";
import { DesktopWindows } from "../../window/DesktopWindows";
import {
  GameRendererRpc,
  GameRendererUnavailableError,
} from "../rpc/GameRendererRpc";
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

describe("environment fallback logging", () => {
  it.effect.each([false, true])(
    "logs failed requests with defect=%s",
    (defect) =>
      Effect.gen(function* () {
        const records: DesktopLogRecord[] = [];
        let ready = true;
        const failure = new GameRendererUnavailableError({
          detail: "renderer failed",
        });
        const environments = yield* makeGameEnvironments.pipe(
          Effect.provideService(
            GameRendererRpc,
            GameRendererRpc.of({
              call: () =>
                Effect.failCause(
                  defect ? Cause.die(failure) : Cause.fail(failure),
                ),
              onConnected: () => Effect.void,
            }),
          ),
          Effect.provide(
            Layer.mock(DesktopWindows, {
              describe: () =>
                Effect.sync(() =>
                  ready
                    ? {
                        rendererId: 42,
                        kind: "game" as const,
                        windowId: 1,
                        ownerId: undefined,
                        generation: 1,
                        ready: true,
                      }
                    : undefined,
                ),
              observe: () => Effect.void,
            }),
          ),
        );
        yield* Effect.gen(function* () {
          expect(yield* environments.fetchBoosts(42)).toEqual(emptyDiscovery);
          expect(yield* environments.withdrawBoosts(43, [3])).toEqual([]);
          expect(
            records.map(({ level, message, data, repeatKey }) => ({
              level,
              message,
              data,
              repeatKey,
            })),
          ).toEqual([
            {
              level: defect ? "error" : "warn",
              message: "Game renderer request failed",
              data: { rendererId: 42, operation: "EnvironmentFetchBoosts" },
              repeatKey: "42:EnvironmentFetchBoosts",
            },
            {
              level: defect ? "error" : "warn",
              message: "Game renderer request failed",
              data: { rendererId: 43, operation: "EnvironmentWithdrawBoosts" },
              repeatKey: "43:EnvironmentWithdrawBoosts",
            },
          ]);
          expect(
            records.every(
              (record) => record.error?.[0]?.message === "renderer failed",
            ),
          ).toBe(true);
          if (!defect) {
            ready = false;
            expect(yield* environments.fetchBoosts(42)).toEqual(emptyDiscovery);
            expect(yield* environments.withdrawBoosts(43, [3])).toEqual([]);
            expect(records).toHaveLength(2);
          }
          expect(yield* environments.withdrawBoosts(43, [])).toEqual([]);
          expect(records).toHaveLength(2);
        }).pipe(
          Effect.provide(
            Logger.layer(
              [
                Logger.make((options) =>
                  records.push(desktopLogRecord(options)),
                ),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
      }),
  );

  it.effect("keeps interrupted requests silent", () =>
    Effect.gen(function* () {
      const records: DesktopLogRecord[] = [];
      const environments = yield* makeGameEnvironments.pipe(
        Effect.provideService(
          GameRendererRpc,
          GameRendererRpc.of({
            call: () => Effect.interrupt,
            onConnected: () => Effect.void,
          }),
        ),
        Effect.provide(
          Layer.mock(DesktopWindows, {
            observe: () => Effect.void,
            describe: () => Effect.succeed(undefined),
          }),
        ),
      );
      expect(
        yield* environments
          .fetchBoosts(42)
          .pipe(
            Effect.provide(
              Logger.layer(
                [
                  Logger.make((options) =>
                    records.push(desktopLogRecord(options)),
                  ),
                ],
                { mergeWithExisting: false },
              ),
            ),
          ),
      ).toEqual(emptyDiscovery);
      expect(records).toEqual([]);
    }),
  );
});

it.effect(
  "keeps RPC-converted interruption silent while the renderer is ready",
  () =>
    Effect.gen(function* () {
      const records: DesktopLogRecord[] = [];
      const game = yield* makeTestGameRenderer();
      const environments = yield* makeGameEnvironments.pipe(
        Effect.provideService(DesktopWindows, game.windows),
        Effect.provideService(
          GameRendererRpc,
          GameRendererRpc.of({
            onConnected: game.rpc.onConnected,
            call: (rendererId, _request, options) =>
              game.rpc.call(rendererId, () => Effect.interrupt, options),
          }),
        ),
      );
      yield* game.ready;
      yield* Effect.gen(function* () {
        expect(yield* environments.fetchBoosts(42)).toEqual(emptyDiscovery);
        expect(yield* environments.withdrawBoosts(42, [3])).toEqual([]);
        expect(records).toEqual([]);
      }).pipe(
        Effect.provide(
          Logger.layer(
            [Logger.make((options) => records.push(desktopLogRecord(options)))],
            { mergeWithExisting: false },
          ),
        ),
      );
    }),
);
