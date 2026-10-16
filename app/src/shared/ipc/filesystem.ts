import * as Schema from "effect/Schema";

import {
  FileSystemEntrySchema,
  FileSystemFailureSchema,
} from "@lucent/core/filesystem";
import { defineInvoke, type IpcSchema } from "./core";

export const FileSystemSessionIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
);

const sessionPayload = Schema.Struct({
  sessionId: FileSystemSessionIdSchema,
});

const pathPayload = Schema.Struct({
  path: Schema.String,
  sessionId: FileSystemSessionIdSchema,
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
  openSession: defineInvoke({
    channel: "lucent:filesystem:open-session",
    name: "filesystem.openSession",
    payload: Schema.Void,
    result: FileSystemSessionIdSchema,
  }),
  closeSession: defineInvoke({
    channel: "lucent:filesystem:close-session",
    name: "filesystem.closeSession",
    payload: sessionPayload,
    result: Schema.Void,
  }),
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
      sessionId: FileSystemSessionIdSchema,
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
      sessionId: FileSystemSessionIdSchema,
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
      sessionId: FileSystemSessionIdSchema,
    }),
    result: resultSchema(Schema.Void),
  }),
} as const;

export const FileSystemIpcMethods = [
  FileSystemIpc.openSession,
  FileSystemIpc.closeSession,
  FileSystemIpc.exists,
  FileSystemIpc.list,
  FileSystemIpc.readJson,
  FileSystemIpc.readText,
  FileSystemIpc.remove,
  FileSystemIpc.writeJson,
  FileSystemIpc.writeText,
] as const;
