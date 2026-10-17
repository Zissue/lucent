import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { createConnection, createServer } from "net";
import { join } from "path";

import * as Schema from "effect/Schema";

import { parseLocalJson } from "../filesystem/parseLocalJson";
import { isMissingFileError } from "./ScriptPackageFileSystem";

const decodeOwner = Schema.decodeUnknownSync(
  Schema.Struct({
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  }),
);

const readOwner = async (path: string) => {
  try {
    return decodeOwner(
      parseLocalJson(await fs.readFile(join(path, "owner.json"), "utf8")),
    );
  } catch (cause) {
    if (isMissingFileError(cause)) return undefined;
    throw cause;
  }
};

const isOccupied = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "EEXIST" || cause.code === "ENOTEMPTY");

const OWNER_PROBE_TIMEOUT_MS = 1_000;

// Keep Unix socket paths short regardless of the workspace or temp directory.
const ownerEndpoint = (token: string): string =>
  process.platform === "win32"
    ? String.raw`\\.\pipe\lucent-seed-${token}`
    : `/tmp/lucent-seed-${token}`;

const isOwnerAlive = (token: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(ownerEndpoint(token));
    const finish = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (cause) =>
      finish(
        !(
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
        ),
      ),
    );
    // A timeout or access error does not prove that the owner exited.
    socket.setTimeout(OWNER_PROBE_TIMEOUT_MS, () => finish(true));
  });

/** A local listener identifies each live claim without relying on reusable process IDs. */
export const acquireBundledScriptPackageLock = async (
  path: string,
): Promise<(() => Promise<void>) | undefined> => {
  const token = randomBytes(16).toString("hex");
  const candidate = `${path}.${token}`;
  const server = createServer((socket) => socket.destroy());
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  let claimed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ownerEndpoint(token), resolve);
    });
    server.unref();
    await fs.mkdir(candidate);
    await fs.writeFile(
      join(candidate, "owner.json"),
      JSON.stringify({ token }),
      { flag: "wx" },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // A complete directory can be published atomically and cannot replace
        // another owner's nonempty directory.
        await fs.rename(candidate, path);
        claimed = true;
        return async () => {
          try {
            if ((await readOwner(path))?.token !== token) return;
            await fs.rename(path, candidate);
            await fs.rm(candidate, { recursive: true });
          } finally {
            await close();
          }
        };
      } catch (cause) {
        const owner = await readOwner(path);
        if (owner === undefined) {
          if (!isOccupied(cause)) throw cause;
          continue;
        }
        if (await isOwnerAlive(owner.token)) return undefined;
        if ((await readOwner(path))?.token !== owner.token) continue;
        try {
          // Keep crashed owners' directories. Concurrent recovery of the same
          // token cannot replace that nonempty directory and steal a newer lock.
          await fs.rename(path, `${path}.retired-${owner.token}`);
        } catch (retireCause) {
          if (isMissingFileError(retireCause)) continue;
          const retired = await readOwner(`${path}.retired-${owner.token}`);
          if (retired?.token !== owner.token) throw retireCause;
        }
        if (process.platform !== "win32") {
          await fs.unlink(ownerEndpoint(owner.token)).catch(() => undefined);
        }
      }
    }
    return undefined;
  } finally {
    if (!claimed) await close();
    await fs.rm(candidate, { recursive: true }).catch(() => undefined);
  }
};
