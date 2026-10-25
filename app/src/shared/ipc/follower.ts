import {
  FollowerConfigSchema,
  FollowerStartPayloadSchema,
  FollowerStateSchema,
} from "@lucent/core/follower";
import * as Schema from "effect/Schema";

import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:follower";

export const FollowerPlayersSchema = Schema.Array(Schema.String);
export type FollowerPlayers = typeof FollowerPlayersSchema.Type;

export const FollowerIpc = {
  getConfig: defineInvoke({
    channel: `${namespace}:get-config`,
    payload: Schema.Void,
    result: Schema.NullOr(FollowerConfigSchema),
  }),
  configure: defineInvoke({
    channel: `${namespace}:configure`,
    payload: FollowerStartPayloadSchema,
    result: FollowerStateSchema,
  }),
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    payload: Schema.Void,
    result: FollowerStateSchema,
  }),
  getPlayers: defineInvoke({
    channel: `${namespace}:get-players`,
    payload: Schema.Void,
    result: FollowerPlayersSchema,
  }),
  me: defineInvoke({
    channel: `${namespace}:me`,
    payload: Schema.Void,
    result: Schema.String,
  }),
  start: defineInvoke({
    channel: `${namespace}:start`,
    payload: FollowerStartPayloadSchema,
    result: FollowerStateSchema,
  }),
  stop: defineInvoke({
    channel: `${namespace}:stop`,
    payload: Schema.Void,
    result: FollowerStateSchema,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: FollowerStateSchema,
  }),
  playersChanged: defineEvent({
    channel: `${namespace}:players-changed`,
    payload: FollowerPlayersSchema,
  }),
  publishState: defineInvoke({
    channel: `${namespace}:publish-state`,
    payload: FollowerStateSchema,
    result: Schema.Void,
  }),
  publishPlayers: defineInvoke({
    channel: `${namespace}:publish-players`,
    payload: FollowerPlayersSchema,
    result: Schema.Void,
  }),
} as const;
