import {
  createIdleFollowerState,
  FollowerStateSchema,
} from "@lucent/core/follower";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { FollowerIpc } from "../../../shared/ipc/follower";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import { GameFollowers } from "../../game/follower/GameFollowers";
import { GameRendererUnavailableError } from "../../game/rpc/GameRendererRpc";
import { DesktopWindows } from "../../window/DesktopWindows";
import { makeLifetime } from "../../window/RendererLifetimeTesting";
import { DesktopIpc } from "../DesktopIpc";
import { getState, publishState } from "./follower";

it.effect("normalizes optional text before publishing follower state", () =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const incoming = yield* Schema.decodeEffect(FollowerStateSchema)({
      ...createIdleFollowerState(),
      targetName: "target",
      lastError: "  ",
      warning: " Warning ",
    });
    yield* publishState
      .handler(incoming, {
        rendererId: 42,
        kind: "game",
        lifetime: makeLifetime(42),
      })
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GameFollowers, {
              set: (_rendererId, state) => Effect.succeed(state),
            }),
            Layer.mock(DesktopWindows, {
              getOwnedRendererIds: () => Effect.succeed([142]),
            }),
            Layer.mock(DesktopIpc, {
              sendToRendererIds: (ids, descriptor, payload) =>
                Effect.sync(() => {
                  sent.push({ ids, channel: descriptor.channel, payload });
                }),
            }),
          ),
        ),
      );

    expect(sent).toEqual([
      {
        ids: [142],
        channel: FollowerIpc.changed.channel,
        payload: {
          enabled: false,
          running: false,
          targetName: "target",
          phase: "idle",
          attemptsRemaining: 3,
          warning: "Warning",
        },
      },
    ]);
  }),
);

it.effect(
  "logs each cached-state failure and keeps closing races silent",
  () => {
    const records: DesktopLogRecord[] = [];
    let fail = true;
    let ready = true;
    let failure = new GameRendererUnavailableError({
      reason: "timeout",
      detail: "state request failed",
    });
    const cached = { ...createIdleFollowerState(), targetName: "private" };
    const dependencies = Layer.mergeAll(
      Layer.mock(GameFollowers, {
        fetchState: () =>
          fail ? Effect.fail(failure) : Effect.succeed(cached),
        get: () => Effect.succeed(cached),
      }),
      Layer.mock(DesktopWindows, {
        describe: (rendererId) =>
          Effect.sync(() => ({
            rendererId,
            kind: rendererId === 42 ? ("game" as const) : ("follower" as const),
            windowId: 1,
            ownerId: rendererId === 42 ? undefined : 42,
            lifetime: makeLifetime(rendererId),
            ready,
          })),
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
      const failureRecord = {
        level: "warn",
        message: "Game renderer request failed",
        component: "game-renderer",
        data: { rendererId: 42, operation: "FollowerGetState" },
        repeatKey: "42:FollowerGetState",
        error: [{ message: "state request failed" }],
      };
      expect(records).toMatchObject([failureRecord, failureRecord]);
      expect(records[0]?.data).toEqual({
        rendererId: 42,
        operation: "FollowerGetState",
      });
      fail = false;
      expect(yield* request).toEqual(cached);
      fail = true;
      expect(yield* request).toEqual(cached);
      expect(records).toHaveLength(3);
      for (const reason of ["loading", "disconnected"] as const) {
        failure = new GameRendererUnavailableError({
          reason,
          detail: "state request failed",
        });
        expect(yield* request).toEqual(cached);
      }
      expect(records).toHaveLength(3);
      failure = new GameRendererUnavailableError({
        reason: "disconnected",
        detail: "state request failed",
        cause: new Error("The port closed."),
      });
      expect(yield* request).toEqual(cached);
      expect(records).toHaveLength(4);
      expect(records[3]).toMatchObject(failureRecord);
      fail = false;
      yield* request;
      fail = true;
      ready = false;
      expect(yield* request).toEqual(cached);
      expect(records).toHaveLength(4);
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
