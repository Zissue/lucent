import * as Schema from "effect/Schema";

import { defineInvoke } from "./core";

const namespace = "desktop:game-renderer";

export const GAME_RENDERER_RPC_PORT_CHANNEL = `${namespace}:rpc-port`;
export const GAME_RENDERER_RPC_PORT_MESSAGE = "lucent:game-renderer-rpc-port";

export const GameRendererIpc = {
  beginScriptExecution: defineInvoke({
    channel: `${namespace}:begin-script-execution`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  finishScriptExecution: defineInvoke({
    channel: `${namespace}:finish-script-execution`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  getGeneration: defineInvoke({
    channel: `${namespace}:get-generation`,
    payload: Schema.Void,
    result: Schema.Int,
  }),
  ready: defineInvoke({
    channel: `${namespace}:ready`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
} as const;
