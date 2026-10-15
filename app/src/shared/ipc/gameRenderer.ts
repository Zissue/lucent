import * as Schema from "effect/Schema";

import { defineInvoke } from "./core";

const namespace = "desktop:game-renderer";

export const GAME_RENDERER_RPC_PORT_CHANNEL = `${namespace}:rpc-port`;
export const GAME_RENDERER_RPC_PORT_MESSAGE = "lucent:game-renderer-rpc-port";

export const GameRendererIpc = {
  beginScriptExecution: defineInvoke({
    channel: `${namespace}:begin-script-execution`,
    name: "gameRenderer.beginScriptExecution",
    payload: Schema.Void,
    result: Schema.Int,
  }),
  finishScriptExecution: defineInvoke({
    channel: `${namespace}:finish-script-execution`,
    name: "gameRenderer.finishScriptExecution",
    payload: Schema.Struct({ token: Schema.Int }),
    result: Schema.Void,
  }),
  getGeneration: defineInvoke({
    channel: `${namespace}:get-generation`,
    name: "gameRenderer.getGeneration",
    payload: Schema.Void,
    result: Schema.Int,
  }),
  ready: defineInvoke({
    channel: `${namespace}:ready`,
    name: "gameRenderer.ready",
    payload: Schema.Void,
    result: Schema.Void,
  }),
} as const;
