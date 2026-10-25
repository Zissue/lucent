import { createHash } from "node:crypto";
import { shell } from "electron";

import { logFailure } from "../../shared/logFailure";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ElectronShellShape {
  readonly openExternal: (url: URL) => Effect.Effect<boolean>;
  readonly openPath: (path: string) => Effect.Effect<boolean>;
  readonly showItemInFolder: (path: string) => Effect.Effect<void>;
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  ElectronShellShape
>()("lucent/desktop/electron/ElectronShell") {}

const shellFailure = (cause: unknown, target: string): Error =>
  new Error(
    (cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "The shell request failed"
    ).replaceAll(target, "[target]"),
  );

const openExternal: ElectronShellShape["openExternal"] = (url) =>
  Effect.tryPromise({
    try: () => shell.openExternal(url.href),
    catch: (cause) => shellFailure(cause, url.href),
  }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      logFailure("Failed to open external URL", cause, {
        failure: "warning",
      }).pipe(
        Effect.annotateLogs({
          component: "electron-shell",
          data: { host: url.host },
          repeatKey: url.host,
        }),
        Effect.as(false),
      ),
    ),
  );

const openPath: ElectronShellShape["openPath"] = (path) =>
  Effect.tryPromise({
    try: () => shell.openPath(path),
    catch: (cause) => shellFailure(cause, path),
  }).pipe(
    Effect.flatMap((message) =>
      message === ""
        ? Effect.succeed(true)
        : Effect.fail(shellFailure(message, path)),
    ),
    Effect.catchCause((cause) =>
      logFailure("Failed to open filesystem path", cause, {
        failure: "warning",
      }).pipe(
        Effect.annotateLogs({
          component: "electron-shell",
          data: {},
          repeatKey: createHash("sha256").update(path).digest("hex"),
        }),
        Effect.as(false),
      ),
    ),
  );

const showItemInFolder: ElectronShellShape["showItemInFolder"] = (path) =>
  Effect.sync(() => {
    shell.showItemInFolder(path);
  });

export const layer = Layer.succeed(
  ElectronShell,
  ElectronShell.of({
    openExternal,
    openPath,
    showItemInFolder,
  }),
);
