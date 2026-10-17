import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PacketsIpc } from "../../../shared/ipc/packets";
import type { PacketsStatusPayload } from "../../../shared/packets";
import { DesktopIpc } from "../../ipc/DesktopIpc";
import { DesktopWindows } from "../../window/DesktopWindows";

const stoppedStatus = (stoppedReason?: string): PacketsStatusPayload => ({
  captureRunning: false,
  queueRunning: false,
  ...(stoppedReason === undefined ? {} : { stoppedReason }),
});

export interface GamePacketsShape {
  readonly getStatus: (
    gameRendererId: number,
  ) => Effect.Effect<PacketsStatusPayload>;
  readonly publishStatus: (
    gameRendererId: number,
    status: PacketsStatusPayload,
  ) => Effect.Effect<void>;
}

export class GamePackets extends Context.Service<
  GamePackets,
  GamePacketsShape
>()("lucent/internal/packets/GamePackets") {}

export const makeGamePackets = Effect.gen(function* () {
  const ipc = yield* DesktopIpc;
  const windows = yield* DesktopWindows;
  const statuses = new Map<number, PacketsStatusPayload>();

  const getStatus: GamePacketsShape["getStatus"] = (gameRendererId) =>
    windows
      .describe(gameRendererId)
      .pipe(
        Effect.map((info) =>
          info?.ready
            ? (statuses.get(gameRendererId) ?? stoppedStatus())
            : stoppedStatus(),
        ),
      );

  const publishStatus: GamePacketsShape["publishStatus"] = Effect.fn(
    "GamePackets.publishStatus",
  )(function* (gameRendererId, status) {
    const next = { ...status };
    statuses.set(gameRendererId, next);
    const targets = yield* windows
      .getOwnedRendererIds(gameRendererId, "packets")
      .pipe(Effect.orElseSucceed(() => []));
    yield* ipc.sendToRendererIds(targets, PacketsIpc.status, next);
  });

  yield* windows.observe({ kind: "game" }, (event) => {
    switch (event.type) {
      case "closed":
        return Effect.sync(() => {
          statuses.delete(event.rendererId);
        });
      case "crashed":
      case "reloaded":
        return publishStatus(
          event.rendererId,
          stoppedStatus(
            event.type === "crashed"
              ? "Packet activity stopped because the game closed or crashed"
              : undefined,
          ),
        );
      default:
        return Effect.void;
    }
  });

  return GamePackets.of({ getStatus, publishStatus });
});

export const layer = Layer.effect(GamePackets, makeGamePackets);
