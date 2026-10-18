import {
  createIdleFollowerState,
  normalizeFollowerConfig,
  type FollowerConfig,
} from "@lucent/core/follower";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { FollowerIpc } from "../../../shared/ipc/follower";
import { DesktopIpc } from "../../ipc/DesktopIpc";
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
import { makeGameFollowers } from "./GameFollowers";

const idleIpc = DesktopIpc.of({
  handle: () => Effect.void,
  sendToAll: () => Effect.void,
  sendToRendererIds: () => Effect.void,
});

const makeFollowers = Effect.fn(function* (
  options: {
    readonly handlers?: Partial<GameRendererRpcHandlerMap>;
    readonly ipc?: DesktopIpc["Service"];
  } = {},
) {
  const game = yield* makeTestGameRenderer(options.handlers);
  const followers = yield* makeGameFollowers.pipe(
    Effect.provideService(DesktopIpc, options.ipc ?? idleIpc),
    Effect.provideService(DesktopWindows, game.windows),
    Effect.provideService(GameRendererRpc, game.rpc),
  );
  return { followers, game };
});

describe("GameFollowers", () => {
  it.effect("isolates, deduplicates, and clears cached player rosters", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<
        readonly {
          readonly ids: readonly number[];
          readonly payload: unknown;
        }[]
      >([]);
      const ipc = DesktopIpc.of({
        handle: () => Effect.void,
        sendToAll: () => Effect.void,
        sendToRendererIds: (ids, descriptor, payload) =>
          descriptor.channel === FollowerIpc.playersChanged.channel
            ? Ref.update(sent, (messages) => [...messages, { ids, payload }])
            : Effect.void,
      });
      const game = yield* makeTestGameRenderer();
      let closed: Effect.Effect<void, unknown> = Effect.die(
        "Window observer was not registered.",
      );
      const followers = yield* makeGameFollowers.pipe(
        Effect.provideService(DesktopIpc, ipc),
        Effect.provideService(GameRendererRpc, game.rpc),
        Effect.provideService(
          DesktopWindows,
          DesktopWindows.of({
            ...game.windows,
            observe: (filter, listener) => {
              closed = listener({
                type: "closed",
                generation: 1,
                kind: "game",
                rendererId: TEST_GAME_RENDERER_ID,
              });
              return game.windows.observe(filter, listener);
            },
          }),
        ),
      );
      yield* game.ready;

      expect(yield* followers.getPlayers(42)).toEqual([]);
      expect((yield* followers.setPlayers(42, ["Alice", "Bob"])).changed).toBe(
        true,
      );
      expect((yield* followers.setPlayers(42, ["Alice", "Bob"])).changed).toBe(
        false,
      );
      expect(yield* followers.getPlayers(42)).toEqual(["Alice", "Bob"]);
      expect(yield* followers.getPlayers(43)).toEqual([]);

      yield* closed.pipe(Effect.orDie);
      expect(yield* followers.getPlayers(42)).toEqual([]);
      expect(yield* Ref.get(sent)).toEqual([{ ids: [142], payload: [] }]);
    }),
  );

  it.effect("normalizes optional text when receiving renderer state", () =>
    Effect.gen(function* () {
      const { followers, game } = yield* makeFollowers({
        handlers: {
          FollowerGetState: () =>
            Effect.succeed({
              ...createIdleFollowerState(),
              targetName: "target",
              profileId: " profile ",
              profileLabel: " Profile ",
              lastError: "  ",
              stoppedReason: " Stopped ",
              warning: " Warning ",
            }),
        },
      });
      yield* game.ready;

      const expected = {
        enabled: false,
        running: false,
        targetName: "target",
        phase: "idle",
        attemptsRemaining: 3,
        profileId: "profile",
        profileLabel: "Profile",
        stoppedReason: "Stopped",
        warning: "Warning",
      };
      expect(yield* followers.fetchState(TEST_GAME_RENDERER_ID)).toEqual(
        expected,
      );
      expect(yield* followers.get(TEST_GAME_RENDERER_ID)).toEqual(expected);
    }),
  );

  it.effect(
    "remembers a configuration sent while the game reloads and applies it once ready",
    () =>
      Effect.gen(function* () {
        const config = normalizeFollowerConfig({ targetName: "target" });
        const configured = {
          ...createIdleFollowerState(),
          enabled: true,
          targetName: "target",
        };
        const received: FollowerConfig[] = [];
        const changed: unknown[] = [];
        const { followers, game } = yield* makeFollowers({
          handlers: {
            FollowerConfigure: (next) =>
              Effect.sync(() => {
                received.push(next);
                return configured;
              }),
          },
          ipc: DesktopIpc.of({
            handle: () => Effect.void,
            sendToAll: () => Effect.void,
            sendToRendererIds: (ids, descriptor, payload) =>
              Effect.sync(() => {
                if (descriptor.channel === FollowerIpc.changed.channel) {
                  changed.push({ ids, payload });
                }
              }),
          }),
        });

        const error = yield* followers
          .configure(TEST_GAME_RENDERER_ID, config)
          .pipe(Effect.flip);
        expect(error).toEqual(
          new GameRendererUnavailableError({
            reason: "loading",
            detail: "The game is still loading. Try again in a moment.",
          }),
        );
        expect(yield* followers.getConfig(TEST_GAME_RENDERER_ID)).toEqual(
          config,
        );

        yield* game.ready;

        expect(received).toEqual([config]);
        expect(changed).toEqual([{ ids: [142], payload: configured }]);
        expect(yield* followers.get(TEST_GAME_RENDERER_ID)).toEqual(configured);
      }),
  );

  it.effect("reports a follower that does not answer", () =>
    Effect.gen(function* () {
      const { followers, game } = yield* makeFollowers({
        handlers: { FollowerGetState: () => Effect.never },
      });
      yield* game.ready;

      const request = yield* followers
        .fetchState(TEST_GAME_RENDERER_ID)
        .pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(request)).toEqual(
        new GameRendererUnavailableError({
          reason: "timeout",
          detail: "The game did not respond in time. Try again.",
        }),
      );
    }),
  );
});

describe("follower reconciliation logging", () => {
  it.effect(
    "logs reconciliation failure once and keeps renderer teardown silent",
    () =>
      Effect.gen(function* () {
        const records: DesktopLogRecord[] = [];
        let ready = true;
        let connected: (id: number) => Effect.Effect<void> = () => Effect.void;
        const followers = yield* makeGameFollowers.pipe(
          Effect.provideService(DesktopIpc, idleIpc),
          Effect.provideService(
            GameRendererRpc,
            GameRendererRpc.of({
              call: () =>
                Effect.fail(
                  new GameRendererUnavailableError({
                    reason: "timeout",
                    detail: "request timed out",
                  }),
                ),
              onConnected: (listener) =>
                Effect.sync(() => {
                  connected = listener;
                }),
            }),
          ),
          Effect.provide(
            Layer.mock(DesktopWindows, {
              describe: (rendererId) =>
                Effect.sync(() =>
                  ready
                    ? {
                        rendererId,
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
        yield* followers
          .configure(42, normalizeFollowerConfig({ targetName: "private" }))
          .pipe(Effect.flip);
        yield* Effect.gen(function* () {
          yield* connected(42);
          expect(records).toMatchObject([
            {
              level: "warn",
              message: "Game renderer request failed",
              component: "game-renderer",
              data: { rendererId: 42, operation: "FollowerConfigure" },
              repeatKey: "42:FollowerConfigure",
              error: [{ message: "request timed out" }],
            },
          ]);
          expect(records[0]?.data).toEqual({
            rendererId: 42,
            operation: "FollowerConfigure",
          });
          ready = false;
          yield* connected(42);
          expect(records).toHaveLength(1);
          expect(yield* followers.get(42)).toEqual(createIdleFollowerState());
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
});
