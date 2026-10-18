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
    name: "filesystem.exists",
    payload: pathPayload,
    result: resultSchema(Schema.Boolean),
  }),
  list: defineInvoke({
    channel: "lucent:filesystem:list",
    name: "filesystem.list",
    payload: Schema.Struct({
      path: Schema.optionalKey(Schema.String),
    }),
    result: resultSchema(Schema.Array(FileSystemEntrySchema)),
  }),
  readJson: defineInvoke({
    channel: "lucent:filesystem:read-json",
    name: "filesystem.readJson",
    payload: pathPayload,
    result: resultSchema(Schema.UndefinedOr(Schema.Json)),
  }),
  readText: defineInvoke({
    channel: "lucent:filesystem:read-text",
    name: "filesystem.readText",
    payload: pathPayload,
    result: resultSchema(Schema.UndefinedOr(Schema.String)),
  }),
  remove: defineInvoke({
    channel: "lucent:filesystem:remove",
    name: "filesystem.remove",
    payload: pathPayload,
    result: resultSchema(Schema.Void),
  }),
  writeJson: defineInvoke({
    channel: "lucent:filesystem:write-json",
    name: "filesystem.writeJson",
    payload: Schema.Struct({
      path: Schema.String,
      value: Schema.Unknown,
    }),
    result: resultSchema(Schema.Void),
  }),
  writeText: defineInvoke({
    channel: "lucent:filesystem:write-text",
    name: "filesystem.writeText",
    payload: Schema.Struct({
      contents: Schema.String,
      path: Schema.String,
    }),
    result: resultSchema(Schema.Void),
  }),
} as const;
