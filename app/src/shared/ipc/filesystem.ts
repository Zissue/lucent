import * as Schema from "effect/Schema";

import {
  FileSystemEntrySchema,
  FileSystemFailureSchema,
} from "@lucent/core/filesystem";
import { defineInvoke, type IpcSchema } from "./core";

const pathPayload = Schema.Struct({
  path: Schema.String,
});

const resultSchema = <Value>(value: IpcSchema<Value>) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: FileSystemFailureSchema,
    }),
  ]);

export const FileSystemIpc = {
  exists: defineInvoke({
    channel: "lucent:filesystem:exists",
    payload: pathPayload,
    result: resultSchema(Schema.Boolean),
  }),
  list: defineInvoke({
    channel: "lucent:filesystem:list",
    payload: Schema.Struct({
      path: Schema.optionalKey(Schema.String),
    }),
    result: resultSchema(Schema.Array(FileSystemEntrySchema)),
  }),
  readJson: defineInvoke({
    channel: "lucent:filesystem:read-json",
    payload: pathPayload,
    result: resultSchema(Schema.UndefinedOr(Schema.Json)),
  }),
  readText: defineInvoke({
    channel: "lucent:filesystem:read-text",
    payload: pathPayload,
    result: resultSchema(Schema.UndefinedOr(Schema.String)),
  }),
  remove: defineInvoke({
    channel: "lucent:filesystem:remove",
    payload: pathPayload,
    result: resultSchema(Schema.Void),
  }),
  writeJson: defineInvoke({
    channel: "lucent:filesystem:write-json",
    payload: Schema.Struct({
      path: Schema.String,
      value: Schema.Unknown,
    }),
    result: resultSchema(Schema.Void),
  }),
  writeText: defineInvoke({
    channel: "lucent:filesystem:write-text",
    payload: Schema.Struct({
      contents: Schema.String,
      path: Schema.String,
    }),
    result: resultSchema(Schema.Void),
  }),
} as const;
