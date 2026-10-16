import * as Schema from "effect/Schema";

import { HttpRequestPayloadSchema, HttpResultSchema } from "../http";
import { defineInvoke } from "./core";

export const HttpIpc = {
  openSession: defineInvoke({
    channel: "lucent:http:open-session",
    name: "http.openSession",
    payload: Schema.Void,
    result: Schema.String,
  }),
  closeSession: defineInvoke({
    channel: "lucent:http:close-session",
    name: "http.closeSession",
    payload: Schema.Struct({ sessionId: Schema.String }),
    result: Schema.Void,
  }),
  request: defineInvoke({
    channel: "lucent:http:request",
    name: "http.request",
    payload: HttpRequestPayloadSchema,
    result: HttpResultSchema,
  }),
  cancel: defineInvoke({
    channel: "lucent:http:cancel",
    name: "http.cancel",
    payload: Schema.Struct({ sessionId: Schema.String, requestId: Schema.Int }),
    result: Schema.Void,
  }),
} as const;
