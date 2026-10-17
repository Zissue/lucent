import {
  createIdleFollowerState,
  normalizeFollowerConfig,
  type FollowerConfig,
} from "@lucent/core/follower";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
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
import { GameFollowerRequestError, makeGameFollowers } from "./GameFollowers";

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
  it.effect("preserves the renderer RPC failure chain", () =>
    Effect.gen(function* () {
      const rpcFailure = new RpcClientError({
        reason: new RpcClientDefect({
          message: "The connection was closed.",
          cause: undefined,
        }),
      });
      const original = Object.assign(
        new GameRendererUnavailableError({
          detail: "The connection was unavailable.",
        }),
        { cause: rpcFailure },
      );
      const game = yield* makeTestGameRenderer();
      const followers = yield* makeGameFollowers.pipe(
        Effect.provideService(DesktopIpc, idleIpc),
        Effect.provideService(DesktopWindows, game.windows),
        Effect.provideService(
          GameRendererRpc,
          GameRendererRpc.of({
            call: () => Effect.fail(original),
            onConnected: () => Effect.succeed(() => {}),
          }),
        ),
      );

      const error = yield* followers
        .me(TEST_GAME_RENDERER_ID)
        .pipe(Effect.flip);

      expect(error.message).toBe("The connection was unavailable.");
      expect(error.cause).toBe(original);
      expect(error.cause).toHaveProperty("cause", rpcFailure);
    }),
  );

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
      const { followers, game } = yield* makeFollowers({ ipc });
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

      yield* followers.remove(42);
      expect(yield* followers.getPlayers(42)).toEqual([]);
      expect(yield* Ref.get(sent)).toEqual([{ ids: [142], payload: [] }]);
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
          new GameFollowerRequestError({
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
        new GameFollowerRequestError({
          detail: "The game did not respond in time. Try again.",
        }),
      );
    }),
  );
});
