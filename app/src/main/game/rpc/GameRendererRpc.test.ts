import { EventEmitter } from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { TestClock } from "effect/testing";

import { LoaderGrabberError } from "../../../shared/gameRendererRpc";
import { desktopLogErrorDetails } from "../../../shared/logRecord";
import { DesktopWindows } from "../../window/DesktopWindows";
import {
  GameRendererUnavailableError,
  makeGameRendererRpc,
} from "./GameRendererRpc";
import {
  makeTestGameRenderer,
  TEST_GAME_RENDERER_ID,
} from "./GameRendererRpcTesting";

const grabInventory = { type: "inventory" } as const;
const options = { timeout: "1 minute" } as const;

describe("GameRendererRpc", () => {
  it.effect("preserves transport open failures", () =>
    Effect.gen(function* () {
      const original = new Error("The message channel could not be opened.");
      const game = yield* makeTestGameRenderer();
      let ready: Effect.Effect<void, unknown> = Effect.void;
      yield* makeGameRendererRpc({
        open: () => {
          throw original;
        },
      }).pipe(
        Effect.provideService(DesktopWindows, {
          ...game.windows,
          observe: (_filter, listener) =>
            Effect.sync(() => {
              ready = listener({
                type: "ready",
                rendererId: TEST_GAME_RENDERER_ID,
                kind: "game",
                generation: 1,
              });
            }),
        }),
      );

      const error = yield* ready.pipe(Effect.flip);
      expect(error).toBeInstanceOf(GameRendererUnavailableError);
      if (!(error instanceof GameRendererUnavailableError)) return;
      expect(error.message).toBe("The connection was unavailable.");
      expect(error.cause).toBe(original);
      expect(desktopLogErrorDetails(error).cause?.message).toBe(
        "The message channel could not be opened.",
      );
    }),
  );

  it.effect("preserves RPC failures", () =>
    Effect.gen(function* () {
      const original = new RpcClientError({
        reason: new RpcClientDefect({
          message: "The protocol rejected the request.",
          cause: undefined,
        }),
      });
      const game = yield* makeTestGameRenderer();
      yield* game.ready;

      const error = yield* game.rpc
        .call(TEST_GAME_RENDERER_ID, () => Effect.fail(original), options)
        .pipe(Effect.flip);

      expect(error.message).toBe("The connection was unavailable.");
      expect(error.cause).toBe(original);
      expect(desktopLogErrorDetails(error).cause?.message).toBe(
        "RpcClientDefect: The protocol rejected the request.",
      );
    }),
  );

  it.effect(
    "preserves native request failures through the RPC cause chain",
    () =>
      Effect.gen(function* () {
        const original = new Error("The port rejected the request.");
        const game = yield* makeTestGameRenderer();
        const rpc = yield* makeGameRendererRpc({
          open: () =>
            Object.assign(new EventEmitter(), {
              close: () => {},
              start: () => {},
              postMessage: () => {
                throw original;
              },
            }),
        }).pipe(Effect.provideService(DesktopWindows, game.windows));
        yield* game.ready;

        const error = yield* rpc
          .call(TEST_GAME_RENDERER_ID, (client) => client.FollowerMe(), options)
          .pipe(Effect.flip);

        expect(error.message).toBe("The connection was unavailable.");
        expect(error.cause).toBeInstanceOf(RpcClientError);
        if (!(error.cause instanceof RpcClientError)) return;
        expect(error.cause.reason).toBeInstanceOf(RpcClientDefect);
        if (!(error.cause.reason instanceof RpcClientDefect)) return;
        expect(error.cause.reason.cause).toBe(original);
        expect(desktopLogErrorDetails(error).cause?.cause?.cause?.message).toBe(
          "The port rejected the request.",
        );
      }),
  );

  it.effect("returns renderer results and typed renderer errors", () =>
    Effect.gen(function* () {
      const game = yield* makeTestGameRenderer({
        LoaderGrabberGrab: () => Effect.succeed([]),
        LoaderGrabberLoad: () =>
          Effect.fail(
            new LoaderGrabberError({ detail: "The player is not ready." }),
          ),
      });
      yield* game.ready;

      expect(
        yield* game.rpc.call(
          TEST_GAME_RENDERER_ID,
          (client) => client.LoaderGrabberGrab(grabInventory),
          options,
        ),
      ).toEqual([]);
      const error = yield* game.rpc
        .call(
          TEST_GAME_RENDERER_ID,
          (client) => client.LoaderGrabberLoad({ type: "armor-customizer" }),
          options,
        )
        .pipe(Effect.flip);
      expect(error).toEqual(
        new LoaderGrabberError({ detail: "The player is not ready." }),
      );
    }),
  );

  it.effect("rejects calls until the renderer reports ready", () =>
    Effect.gen(function* () {
      const game = yield* makeTestGameRenderer();

      const error = yield* game.rpc
        .call(
          TEST_GAME_RENDERER_ID,
          (client) => client.LoaderGrabberGrab(grabInventory),
          options,
        )
        .pipe(Effect.flip);
      expect(error).toEqual(
        new GameRendererUnavailableError({
          detail: "The game is still loading. Try again in a moment.",
        }),
      );
    }),
  );

  it.effect("lets connection listeners call a renderer once it is ready", () =>
    Effect.gen(function* () {
      const game = yield* makeTestGameRenderer({
        FollowerMe: () => Effect.succeed("Alice"),
      });
      const usernames: string[] = [];
      yield* game.rpc.onConnected((gameRendererId) =>
        game.rpc
          .call(gameRendererId, (client) => client.FollowerMe(), options)
          .pipe(
            Effect.tap((username) =>
              Effect.sync(() => usernames.push(username)),
            ),
            Effect.orDie,
          ),
      );

      yield* game.ready;

      expect(usernames).toEqual(["Alice"]);
    }),
  );

  it.effect("fails in-flight calls when the renderer reloads", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const game = yield* makeTestGameRenderer({
        LoaderGrabberGrab: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
      });
      yield* game.ready;

      const call = yield* game.rpc
        .call(
          TEST_GAME_RENDERER_ID,
          (client) => client.LoaderGrabberGrab(grabInventory),
          options,
        )
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* game.reload;

      expect(yield* Fiber.join(call)).toEqual(
        new GameRendererUnavailableError({
          detail: "The connection was unavailable.",
        }),
      );
    }),
  );

  it.effect("fails in-flight calls when the renderer closes its port", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const game = yield* makeTestGameRenderer({
        LoaderGrabberGrab: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
      });
      yield* game.ready;

      const call = yield* game.rpc
        .call(
          TEST_GAME_RENDERER_ID,
          (client) => client.LoaderGrabberGrab(grabInventory),
          options,
        )
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* game.stopRenderer;

      expect(yield* Fiber.join(call)).toEqual(
        new GameRendererUnavailableError({
          detail: "The connection was unavailable.",
        }),
      );
    }),
  );

  it.effect(
    "preserves caller cancellation and interrupts the renderer handler",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const game = yield* makeTestGameRenderer({
          LoaderGrabberGrab: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined),
              ),
            ),
        });
        yield* game.ready;

        const call = yield* game.rpc
          .call(
            TEST_GAME_RENDERER_ID,
            (client) => client.LoaderGrabberGrab(grabInventory),
            options,
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(call);

        const exit = yield* Fiber.await(call);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
        yield* Deferred.await(interrupted);
      }),
  );

  it.effect(
    "times out and interrupts a renderer handler that does not answer",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const game = yield* makeTestGameRenderer({
          LoaderGrabberGrab: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined),
              ),
            ),
        });
        yield* game.ready;

        const call = yield* game.rpc
          .call(
            TEST_GAME_RENDERER_ID,
            (client) => client.LoaderGrabberGrab(grabInventory),
            { timeout: "5 seconds" },
          )
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");

        expect(yield* Fiber.join(call)).toEqual(
          new GameRendererUnavailableError({
            detail: "The game did not respond in time. Try again.",
          }),
        );
        yield* Deferred.await(interrupted);
      }),
  );
});
