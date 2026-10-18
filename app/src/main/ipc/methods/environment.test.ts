import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import {
  GameEnvironments,
  makeGameEnvironments,
} from "../../game/environment/GameEnvironments";
import { GameRendererRpc } from "../../game/rpc/GameRendererRpc";
import { makeTestGameRenderer } from "../../game/rpc/GameRendererRpcTesting";
import { DesktopWindows } from "../../window/DesktopWindows";
import { makeLifetime } from "../../window/RendererLifetimeTesting";
import { createDesktopIpcInvokeHandler } from "../DesktopIpcInvoke";
import { fetchBoosts, withdrawBoosts } from "./environment";

it.effect.each(["fetch", "withdraw"] as const)(
  "returns a failed boost %s IPC response and logs it once",
  (operation) =>
    Effect.gen(function* () {
      const records: DesktopLogRecord[] = [];
      const game = yield* makeTestGameRenderer();
      const environments = yield* makeGameEnvironments.pipe(
        Effect.provideService(DesktopWindows, game.windows),
        Effect.provideService(GameRendererRpc, game.rpc),
      );
      const channel =
        operation === "fetch"
          ? "desktop:environment:fetch-boosts"
          : "desktop:environment:withdraw-boosts";
      const envelope = yield* Effect.gen(function* () {
        const runPromise = Effect.runPromiseWith(
          yield* Effect.context<GameEnvironments | DesktopWindows>(),
        );
        const invoke =
          operation === "fetch"
            ? createDesktopIpcInvokeHandler(
                fetchBoosts.descriptor,
                fetchBoosts.handler,
                runPromise,
              )
            : createDesktopIpcInvokeHandler(
                withdrawBoosts.descriptor,
                withdrawBoosts.handler,
                runPromise,
              );
        return yield* Effect.promise(() =>
          invoke(
            {
              rendererId: 42,
              kind: "game",
              lifetime: makeLifetime(42),
            },
            operation === "fetch" ? undefined : { itemIds: [3] },
          ),
        );
      }).pipe(
        Effect.provideService(GameEnvironments, environments),
        Effect.provideService(DesktopWindows, game.windows),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((options) => records.push(desktopLogRecord(options))),
          ]),
        ),
      );

      expect(envelope).toEqual({
        ok: false,
        error: {
          channel,
          code: "IPC_HANDLER_FAILED",
          message: "The game is still loading. Try again in a moment.",
        },
      });
      expect(
        records.map(({ level, message, component, data, repeatKey }) => ({
          level,
          message,
          component,
          data,
          repeatKey,
        })),
      ).toEqual([
        {
          level: "warn",
          message: "IPC handler failed",
          component: "ipc",
          data: { channel },
          repeatKey: channel,
        },
      ]);
    }),
);
