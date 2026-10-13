import * as Effect from "effect/Effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import { PacketsError } from "../../../shared/gameRendererRpc";
import {
  PacketsIpc,
  type IpcEventDescriptor,
  type IpcEventPayload,
} from "../../../shared/ipc";
import { normalizePacketQueuePayload } from "../../../shared/packets";
import {
  GameRendererRpc,
  type GameRendererRpcClient,
} from "../../internal/game-renderer/GameRendererRpc";
import { GamePackets } from "../../internal/packets/GamePackets";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";
import {
  resolveGameRendererId,
  type DesktopIpcSender,
} from "../DesktopIpcSenders";

const PACKETS_REQUEST_TIMEOUT_MS = 5_000;

const requestGame = Effect.fn("desktop.ipc.packets.requestGame")(function* (
  sender: DesktopIpcSender,
  request: (
    client: GameRendererRpcClient,
  ) => Effect.Effect<void, PacketsError | RpcClientError>,
) {
  const rpc = yield* GameRendererRpc;
  const gameRendererId = yield* resolveGameRendererId(sender);
  yield* rpc.call(gameRendererId, request, {
    timeout: PACKETS_REQUEST_TIMEOUT_MS,
  });
});

const notifyPacketsWindow = Effect.fn("desktop.ipc.packets.notifyWindow")(
  function* <Descriptor extends IpcEventDescriptor<unknown>>(
    gameRendererId: number,
    descriptor: Descriptor,
    payload: IpcEventPayload<Descriptor>,
  ) {
    const ipc = yield* DesktopIpc;
    const windows = yield* DesktopWindows;
    const targets = yield* windows.getOwnedRendererIds(
      gameRendererId,
      "packets",
    );
    yield* ipc.sendToRendererIds(targets, descriptor, payload);
  },
);

export const startCapture = makeDesktopIpcMethod({
  descriptor: PacketsIpc.startCapture,
  allowedSenders: ["packets"],
  handler: (_payload, sender) =>
    requestGame(sender, (client) => client.PacketsStartCapture()),
});

export const getStatus = makeDesktopIpcMethod({
  descriptor: PacketsIpc.getStatus,
  allowedSenders: ["packets"],
  handler: Effect.fn("desktop.ipc.packets.getStatus")(
    function* (_payload, sender) {
      const packets = yield* GamePackets;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* packets.getStatus(gameRendererId);
    },
  ),
});

export const stopCapture = makeDesktopIpcMethod({
  descriptor: PacketsIpc.stopCapture,
  allowedSenders: ["packets"],
  handler: (_payload, sender) =>
    requestGame(sender, (client) => client.PacketsStopCapture()),
});

export const send = makeDesktopIpcMethod({
  descriptor: PacketsIpc.send,
  allowedSenders: ["packets"],
  handler: (payload, sender) =>
    requestGame(sender, (client) => client.PacketsSend(payload)),
});

export const startQueue = makeDesktopIpcMethod({
  descriptor: PacketsIpc.startQueue,
  allowedSenders: ["packets"],
  handler: (payload, sender) =>
    Effect.try({
      try: () => normalizePacketQueuePayload(payload),
      catch: (cause) =>
        new PacketsError({
          detail:
            cause instanceof Error && cause.message !== ""
              ? cause.message
              : "Invalid packet queue.",
        }),
    }).pipe(
      Effect.flatMap((normalized) =>
        requestGame(sender, (client) => client.PacketsStartQueue(normalized)),
      ),
    ),
});

export const stopQueue = makeDesktopIpcMethod({
  descriptor: PacketsIpc.stopQueue,
  allowedSenders: ["packets"],
  handler: (_payload, sender) =>
    requestGame(sender, (client) => client.PacketsStopQueue()),
});

export const publishCaptured = makeDesktopIpcMethod({
  descriptor: PacketsIpc.publishCaptured,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.packets.publishCaptured")(
    function* (payload, sender) {
      const windows = yield* DesktopWindows;
      const rendererReady =
        (yield* windows.describe(sender.rendererId))?.ready ?? false;
      if (rendererReady) {
        yield* notifyPacketsWindow(
          sender.rendererId,
          PacketsIpc.captured,
          payload,
        );
      }
    },
  ),
});

export const publishStatus = makeDesktopIpcMethod({
  descriptor: PacketsIpc.publishStatus,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.packets.publishStatus")(
    function* (payload, sender) {
      const windows = yield* DesktopWindows;
      const rendererReady =
        (yield* windows.describe(sender.rendererId))?.ready ?? false;
      if (!rendererReady) {
        return;
      }

      const packets = yield* GamePackets;
      yield* packets.publishStatus(sender.rendererId, payload);
    },
  ),
});

export const methods = [
  getStatus,
  startCapture,
  stopCapture,
  send,
  startQueue,
  stopQueue,
  publishCaptured,
  publishStatus,
] as const;
