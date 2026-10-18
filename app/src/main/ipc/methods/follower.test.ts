import { createIdleFollowerState } from "@lucent/core/follower";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import {
  GameFollowers,
  GameFollowerRequestError,
} from "../../game/follower/GameFollowers";
import { DesktopWindows } from "../../window/DesktopWindows";
import { makeLifetime } from "../../window/RendererLifetimeTesting";
import { DesktopIpc } from "../DesktopIpc";
import { getState } from "./follower";

it.effect(
  "logs cached-state failure episodes and keeps closing races silent",
  () => {
    const records: DesktopLogRecord[] = [];
    const lifetime = makeLifetime(42);
    let fail = true;
    let ready = true;
    const cached = { ...createIdleFollowerState(), targetName: "private" };
    const dependencies = Layer.mergeAll(
      Layer.mock(GameFollowers, {
        fetchState: () =>
          fail
            ? Effect.fail(
                new GameFollowerRequestError({
                  detail: "state request failed",
                }),
              )
            : Effect.succeed(cached),
        get: () => Effect.succeed(cached),
      }),
      Layer.mock(DesktopWindows, {
        describe: (rendererId) =>
          Effect.sync(() => ({
            rendererId,
            kind: rendererId === 42 ? ("game" as const) : ("follower" as const),
            windowId: 1,
            ownerId: rendererId === 42 ? undefined : 42,
            generation: 1,
            ready,
          })),
        lifetime: () => Effect.succeed(lifetime),
        getOwnedRendererIds: () => Effect.succeed([]),
      }),
      Layer.mock(DesktopIpc, { sendToRendererIds: () => Effect.void }),
    );
    return Effect.gen(function* () {
      const request = getState.handler(undefined, {
        rendererId: 142,
        kind: "follower",
        lifetime: makeLifetime(142),
      });
      expect(yield* request).toEqual(cached);
      expect(yield* request).toEqual(cached);
      expect(records).toMatchObject([
        {
          level: "warn",
          message: "Game renderer request failed",
          component: "game-renderer",
          data: { rendererId: 42, operation: "FollowerGetState" },
          repeatKey: "42:FollowerGetState",
          error: [{ message: "state request failed" }],
        },
      ]);
      expect(records[0]?.data).toEqual({
        rendererId: 42,
        operation: "FollowerGetState",
      });
      fail = false;
      expect(yield* request).toEqual(cached);
      fail = true;
      expect(yield* request).toEqual(cached);
      expect(records).toHaveLength(2);
      fail = false;
      yield* request;
      fail = true;
      ready = false;
      expect(yield* request).toEqual(cached);
      expect(records).toHaveLength(2);
    }).pipe(
      Effect.provide(dependencies),
      Effect.provide(
        Logger.layer(
          [Logger.make((options) => records.push(desktopLogRecord(options)))],
          { mergeWithExisting: false },
        ),
      ),
    );
  },
);
