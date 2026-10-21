import * as Schema from "effect/Schema";

import {
  ArmyLoopTauntCommandPayloadSchema,
  ArmyLoopTauntLeavePayloadSchema,
  ArmyLoopTauntRegisterPayloadSchema,
  ArmyLoopTauntRegisterResultSchema,
  ArmyLoopTauntReportPayloadSchema,
  ArmyLoopTauntRunPayloadSchema,
  ArmyLoopTauntTerminalResultSchema,
  ArmySessionEndedPayloadSchema,
  ArmySessionPayloadSchema,
} from "@lucent/core/army";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:army";

const SyncPayloadFields = {
  label: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  step: Schema.Int,
  timeoutMs: Schema.optionalKey(Schema.Number),
} as const;

const SyncPayloadSchema = Schema.Struct(SyncPayloadFields);

const ProgressResultSchema = Schema.Struct({
  complete: Schema.Boolean,
  completedPlayers: Schema.Array(Schema.String),
  pendingPlayers: Schema.Array(Schema.String),
});

export const ArmyIpc = {
  start: defineInvoke({
    channel: `${namespace}:start`,
    payload: Schema.Struct({
      configName: Schema.String,
      playerName: Schema.String,
    }),
    result: ArmySessionPayloadSchema,
  }),
  leave: defineInvoke({
    channel: `${namespace}:leave`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  sync: defineInvoke({
    channel: `${namespace}:sync`,
    payload: SyncPayloadSchema,
    result: Schema.Void,
  }),
  progress: defineInvoke({
    channel: `${namespace}:progress`,
    payload: Schema.Struct({
      ...SyncPayloadFields,
      complete: Schema.Boolean,
    }),
    result: ProgressResultSchema,
  }),
  fail: defineInvoke({
    channel: `${namespace}:fail`,
    payload: Schema.Struct({
      reason: Schema.String,
      sessionId: Schema.String,
    }),
    result: Schema.Void,
  }),
  loopTauntRegister: defineInvoke({
    channel: `${namespace}:loop-taunt-register`,
    payload: ArmyLoopTauntRegisterPayloadSchema,
    result: ArmyLoopTauntRegisterResultSchema,
  }),
  loopTauntReady: defineInvoke({
    channel: `${namespace}:loop-taunt-ready`,
    payload: ArmyLoopTauntRunPayloadSchema,
    result: Schema.Void,
  }),
  loopTauntAwait: defineInvoke({
    channel: `${namespace}:loop-taunt-await`,
    payload: ArmyLoopTauntRunPayloadSchema,
    result: ArmyLoopTauntTerminalResultSchema,
  }),
  loopTauntReport: defineInvoke({
    channel: `${namespace}:loop-taunt-report`,
    payload: ArmyLoopTauntReportPayloadSchema,
    result: Schema.Void,
  }),
  loopTauntLeave: defineInvoke({
    channel: `${namespace}:loop-taunt-leave`,
    payload: ArmyLoopTauntLeavePayloadSchema,
    result: Schema.Void,
  }),
  ended: defineEvent({
    channel: `${namespace}:ended`,
    payload: ArmySessionEndedPayloadSchema,
  }),
  loopTauntCommand: defineEvent({
    channel: `${namespace}:loop-taunt-command`,
    payload: ArmyLoopTauntCommandPayloadSchema,
  }),
} as const;
