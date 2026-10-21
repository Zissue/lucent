import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  FileSystemError as CoreFileSystemError,
  SCRIPT_FILE_SYSTEM_MAX_BYTES,
  type FileSystemErrorReason,
  type FileSystemOperation,
} from "@lucent/core/filesystem";
import type {
  DesktopFileSystemBridge,
  DesktopFileSystemResult,
} from "../../../../shared/desktopBridge";
import type { ScriptFileSystemApi } from "./ScriptApi";
import type { ScriptAsyncScope } from "./scriptAsyncScope";

const makeError = (
  operation: FileSystemOperation,
  reason: FileSystemErrorReason,
  path?: string,
): CoreFileSystemError =>
  new CoreFileSystemError({
    operation,
    reason,
    ...(path === undefined ? {} : { path }),
  });

const isJson = Schema.is(Schema.Json);
const utf8Encoder = new TextEncoder();

export const makeScriptFileSystemApi = (
  bridge: DesktopFileSystemBridge,
  scope: ScriptAsyncScope,
): ScriptFileSystemApi => {
  const request = <A>(
    operation: FileSystemOperation,
    path: string | undefined,
    invoke: () => Promise<DesktopFileSystemResult<A>>,
    validate?: () => CoreFileSystemError | undefined,
  ): Effect.Effect<A, CoreFileSystemError> =>
    Effect.suspend(() => {
      if (scope.signal.aborted) {
        return Effect.fail(makeError(operation, "session-closed", path));
      }
      const validationError = validate?.();
      if (validationError !== undefined) {
        return Effect.fail(validationError);
      }
      return Effect.tryPromise({
        try: invoke,
        catch: () => makeError(operation, "unavailable", path),
      }).pipe(
        Effect.flatMap((result) =>
          result.ok
            ? Effect.succeed(result.value)
            : Effect.fail(
                makeError(
                  result.error.operation,
                  result.error.reason,
                  result.error.path,
                ),
              ),
        ),
      );
    });

  const api: ScriptFileSystemApi = {
    FileSystemError: CoreFileSystemError,
    exists: (path) => request("exists", path, () => bridge.exists(path)),
    list: (path) =>
      request("list", path, () => bridge.list(path)).pipe(
        Effect.map((entries) =>
          Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
        ),
      ),
    readJson: (path) => request("read-json", path, () => bridge.readJson(path)),
    readText: (path) => request("read-text", path, () => bridge.readText(path)),
    remove: (path) => request("remove", path, () => bridge.remove(path)),
    writeJson: (path, value) =>
      request(
        "write-json",
        path,
        () => bridge.writeJson(path, value),
        () => {
          if (!isJson(value)) {
            return makeError("write-json", "not-json-serializable", path);
          }
          const source = `${JSON.stringify(value, null, 2)}\n`;
          return utf8Encoder.encode(source).byteLength >
            SCRIPT_FILE_SYSTEM_MAX_BYTES
            ? makeError("write-json", "too-large", path)
            : undefined;
        },
      ),
    writeText: (path, contents) =>
      request(
        "write-text",
        path,
        () => bridge.writeText(path, contents),
        () =>
          utf8Encoder.encode(contents).byteLength > SCRIPT_FILE_SYSTEM_MAX_BYTES
            ? makeError("write-text", "too-large", path)
            : undefined,
      ),
  };
  return Object.freeze(api);
};
