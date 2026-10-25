import * as Schema from "effect/Schema";

import {
  PacketCapturedPayloadSchema,
  PacketQueuePayloadSchema,
  PacketSendPayloadSchema,
  PacketsStatusPayloadSchema,
} from "../packets";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:packets";

export const PacketsIpc = {
  getStatus: defineInvoke({
    channel: `${namespace}:get-status`,
    payload: Schema.Void,
    result: PacketsStatusPayloadSchema,
  }),
  startCapture: defineInvoke({
    channel: `${namespace}:start-capture`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  stopCapture: defineInvoke({
    channel: `${namespace}:stop-capture`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  send: defineInvoke({
    channel: `${namespace}:send`,
    payload: PacketSendPayloadSchema,
    result: Schema.Void,
  }),
  startQueue: defineInvoke({
    channel: `${namespace}:start-queue`,
    payload: PacketQueuePayloadSchema,
    result: Schema.Void,
  }),
  stopQueue: defineInvoke({
    channel: `${namespace}:stop-queue`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  captured: defineEvent({
    channel: `${namespace}:captured`,
    payload: PacketCapturedPayloadSchema,
  }),
  status: defineEvent({
    channel: `${namespace}:status`,
    payload: PacketsStatusPayloadSchema,
  }),
  publishCaptured: defineInvoke({
    channel: `${namespace}:publish-captured`,
    payload: PacketCapturedPayloadSchema,
    result: Schema.Void,
  }),
  publishStatus: defineInvoke({
    channel: `${namespace}:publish-status`,
    payload: PacketsStatusPayloadSchema,
    result: Schema.Void,
  }),
} as const;
