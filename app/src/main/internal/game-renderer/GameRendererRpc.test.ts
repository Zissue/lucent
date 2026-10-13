import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { LoaderGrabberError } from "../../../shared/gameRendererRpc";
import { GameRendererUnavailableError } from "./GameRendererRpc";
import {
  makeTestGameRenderer,
  TEST_GAME_RENDERER_ID,
} from "./GameRendererRpcTesting";

const grabInventory = { type: "inventory" } as const;
const options = { timeout: "1 minute" } as const;

describe("GameRendererRpc", () => {
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
