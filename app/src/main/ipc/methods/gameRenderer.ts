import * as Effect from "effect/Effect";

import { GameRendererIpc } from "../../../shared/ipc";
import { DesktopGameRendererRecovery } from "../../app/DesktopGameRendererRecovery";
import { DesktopWindows, requireRenderer } from "../../window/DesktopWindows";
import { makeDesktopIpcMethod } from "../DesktopIpc";

export const ready = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.ready,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.ready")(
    function* (payload, sender) {
      const windows = yield* DesktopWindows;
      yield* windows.markRendererReady(sender.rendererId, payload.generation);
    },
  ),
});

export const beginScriptExecution = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.beginScriptExecution,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.beginScriptExecution")(
    function* (_payload, sender) {
      const recovery = yield* DesktopGameRendererRecovery;
      return yield* recovery.beginScriptExecution(sender.lifetime);
    },
  ),
});

export const finishScriptExecution = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.finishScriptExecution,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.finishScriptExecution")(
    function* (payload, sender) {
      const recovery = yield* DesktopGameRendererRecovery;
      yield* recovery.finishScriptExecution(sender.lifetime, payload.token);
    },
  ),
});

export const getGeneration = makeDesktopIpcMethod({
  descriptor: GameRendererIpc.getGeneration,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.gameRenderer.getGeneration")(
    function* (_payload, sender) {
      const windows = yield* DesktopWindows;
      return (yield* requireRenderer(windows, sender.rendererId)).generation;
    },
  ),
});

export const methods = [
  beginScriptExecution,
  finishScriptExecution,
  getGeneration,
  ready,
] as const;
