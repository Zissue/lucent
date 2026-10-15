import * as Schema from "effect/Schema";

import type { DesktopLogError } from "../logRecord";
import { defineEvent } from "./core";

const DesktopLogErrorSchema: Schema.Codec<DesktopLogError> = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.suspend(() => DesktopLogErrorSchema)),
});

export const RendererLogRecordSchema = Schema.Struct({
  level: Schema.Literals(["error", "warn", "info", "debug"]),
  message: Schema.String,
  component: Schema.optionalKey(Schema.String),
  repeatKey: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Array(DesktopLogErrorSchema)),
});

export type RendererLogRecord = typeof RendererLogRecordSchema.Type;

export const RendererLogIpc = {
  record: defineEvent({
    channel: "desktop:renderer-log:record",
    name: "rendererLog.record",
    payload: RendererLogRecordSchema,
  }),
} as const;
