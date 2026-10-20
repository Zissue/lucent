import * as Effect from "effect/Effect";

import { GameRendererIpc } from "../../../shared/ipc";
import { DesktopGameRendererRecovery } from "../../app/DesktopGameRendererRecovery";
import { DesktopWindows } from "../../window/DesktopWindows";
import { makeDesktopIpcMethod } from "../DesktopIpc";

export const ready = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.ready,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.ready")(
    function* (_payload, sender) {
      const windows = yield* DesktopWindows;
      yield* windows.markRendererReady(sender.lifetime);
    },
  ),
});

export const beginScriptExecution = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.beginScriptExecution,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.beginScriptExecution")(
    function* (_payload, sender) {
      const recovery = yield* DesktopGameRendererRecovery;
      yield* recovery.beginScriptExecution(sender.lifetime);
    },
  ),
});

export const finishScriptExecution = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.finishScriptExecution,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.finishScriptExecution")(
    function* (_payload, sender) {
      const recovery = yield* DesktopGameRendererRecovery;
      yield* recovery.finishScriptExecution(sender.lifetime);
    },
  ),
});

export const getGeneration = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.getGeneration,
  allowedSenders: ["game"],
  handler: (_payload, sender) => Effect.succeed(sender.lifetime.generation),
});

export const methods = [
  beginScriptExecution,
  finishScriptExecution,
  getGeneration,
  ready,
] as const;
