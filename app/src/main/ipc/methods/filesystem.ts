import * as Effect from "effect/Effect";

import { type FileSystemError } from "@lucent/core/filesystem";
import { FileSystemIpc } from "../../../shared/ipc";
import { ScriptFileSystem } from "../../scripting/ScriptFileSystem";
import { makeDesktopIpcMethod } from "../DesktopIpc";

const businessResult = <A>(effect: Effect.Effect<A, FileSystemError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ error, ok: false }) as const,
      onSuccess: (value) => ({ ok: true, value }) as const,
    }),
  );

export const exists = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.exists,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.exists")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(fileSystem.exists(payload.path));
  }),
});

export const list = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.list,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.list")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(fileSystem.list(payload.path));
  }),
});

export const readJson = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.readJson,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.readJson")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(fileSystem.readJson(payload.path));
  }),
});

export const readText = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.readText,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.readText")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(fileSystem.readText(payload.path));
  }),
});

export const remove = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.remove,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.remove")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(fileSystem.remove(payload.path));
  }),
});

export const writeJson = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.writeJson,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.writeJson")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(
      fileSystem.writeJson(payload.path, payload.value),
    );
  }),
});

export const writeText = makeDesktopIpcMethod({
  descriptor: FileSystemIpc.writeText,
  allowedSenders: ["game"],
  handler: Effect.fn("desktop.ipc.filesystem.writeText")(function* (payload) {
    const fileSystem = yield* ScriptFileSystem;
    return yield* businessResult(
      fileSystem.writeText(payload.path, payload.contents),
    );
  }),
});

export const methods = [
  exists,
  list,
  readJson,
  readText,
  remove,
  writeJson,
  writeText,
] as const;
