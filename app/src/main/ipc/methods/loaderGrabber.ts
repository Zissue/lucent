import * as Effect from "effect/Effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import type { LoaderGrabberError } from "../../../shared/gameRendererRpc";
import { LoaderGrabberIpc } from "../../../shared/ipc";
import {
  GameRendererRpc,
  type GameRendererRpcClient,
} from "../../internal/game-renderer/GameRendererRpc";
import { makeDesktopIpcMethod } from "../DesktopIpc";
import {
  resolveGameRendererId,
  type DesktopIpcSender,
} from "../DesktopIpcSenders";

const LOADER_GRABBER_REQUEST_TIMEOUT_MS = 12_000;

const requestOwningGame = Effect.fn("desktop.ipc.loaderGrabber.request")(
  function* <A>(
    sender: DesktopIpcSender,
    request: (
      client: GameRendererRpcClient,
    ) => Effect.Effect<A, LoaderGrabberError | RpcClientError>,
  ) {
    const rpc = yield* GameRendererRpc;
    const gameRendererId = yield* resolveGameRendererId(sender);
    return yield* rpc.call(gameRendererId, request, {
      timeout: LOADER_GRABBER_REQUEST_TIMEOUT_MS,
    });
  },
);

export const load = makeDesktopIpcMethod({
  descriptor: LoaderGrabberIpc.load,
  allowedSenders: ["loader-grabber"],
  handler: (payload, sender) =>
    requestOwningGame(sender, (client) => client.LoaderGrabberLoad(payload)),
});

export const grab = makeDesktopIpcMethod({
  descriptor: LoaderGrabberIpc.grab,
  allowedSenders: ["loader-grabber"],
  handler: (payload, sender) =>
    requestOwningGame(sender, (client) => client.LoaderGrabberGrab(payload)),
});

export const methods = [load, grab] as const;
