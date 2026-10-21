import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { clearSessionData, GameSessions, layer } from "./GameSessions";

const electron = vi.hoisted(() => {
  const makeSession = (
    storagePath: string | null,
    clearData = async () => {},
  ) => ({
    storagePath,
    clearData,
    setUserAgent: vi.fn(),
    webRequest: {
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
  });
  return {
    getPath: vi.fn(() => ""),
    on: vi.fn(),
    removeListener: vi.fn(),
    fromPartition: vi.fn(),
    defaultSession: makeSession(null),
    makeSession,
  };
});
vi.mock("electron", () => ({
  app: {
    getPath: electron.getPath,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  session: {
    fromPartition: electron.fromPartition,
    defaultSession: electron.defaultSession,
  },
}));
const tempDirs = new Set<string>();
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});
const makeTempDir = async () => {
  const path = await mkdtemp(join(tmpdir(), "lucent-sessions-"));
  tempDirs.add(path);
  return path;
};
const makeFileSystem = () =>
  FileSystem.FileSystem.pipe(Effect.provide(nodeFileSystemLayer));
const managedPartition =
  "persist:lucent-game-account-2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90";
const testLayer = (
  sessionDataDir: string,
  fileSystem?: FileSystem.FileSystem,
  cleared: string[] = [],
) => {
  electron.getPath.mockReturnValue(sessionDataDir);
  const sessions = new Map<string, ReturnType<typeof electron.makeSession>>();
  electron.fromPartition.mockImplementation((partition: string) => {
    let target = sessions.get(partition);
    if (target === undefined) {
      target = electron.makeSession(
        partition.startsWith("persist:")
          ? join(
              sessionDataDir,
              "Partitions",
              partition.slice("persist:".length),
            )
          : null,
        async () => {
          cleared.push(partition);
        },
      );
      sessions.set(partition, target);
    }
    return target;
  });
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystem === undefined
          ? nodeFileSystemLayer
          : Layer.succeed(FileSystem.FileSystem, fileSystem),
        Layer.succeed(DesktopEnvironment, {
          appDataDir: sessionDataDir,
          assetsDir: join(sessionDataDir, "assets"),
          isDev: true,
          platform: "darwin",
          workspaceDir: sessionDataDir,
        }),
      ),
    ),
  );
};
describe("game session startup", () => {
  it.effect(
    "keeps sessions unavailable until recursive cold-start cleanup finishes",
    () =>
      Effect.gen(function* () {
        const sessionDataDir = yield* Effect.promise(() => makeTempDir());
        const profilePath = join(
          sessionDataDir,
          "Partitions",
          "lucent-game-temporary-2147483647-aaaaaaaaaaaaaaaaaaaaaaaa",
        );
        yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
        const fileSystem = yield* makeFileSystem();
        const started = Deferred.makeUnsafe<void>();
        const finish = Deferred.makeUnsafe<void>();
        let ready = false;
        const pending = yield* Effect.gen(function* () {
          const sessions = yield* GameSessions;
          ready = true;
          return yield* Effect.scoped(
            sessions.acquireGamePartition({ kind: "default" }),
          );
        }).pipe(
          Effect.provide(
            testLayer(sessionDataDir, {
              ...fileSystem,
              remove: (path, options) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(finish);
                  yield* fileSystem.remove(path, options);
                }),
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.gen(function* () {
          expect(
            yield* Effect.raceFirst(
              Deferred.await(started).pipe(Effect.as("cleanup-started")),
              Fiber.join(pending).pipe(Effect.as("sessions-ready")),
            ),
          ).toBe("cleanup-started");
          expect(ready).toBe(false);
          expect(
            (yield* Effect.promise(() => stat(profilePath))).isDirectory(),
          ).toBe(true);
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(pending)).toBe(
            "persist:lucent-game-default",
          );
          yield* Effect.promise(() =>
            expect(stat(profilePath)).rejects.toMatchObject({ code: "ENOENT" }),
          );
        }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)));
      }),
  );
  it.effect(
    "recovers from startup enumeration failure and reports clear-data discovery failure",
    () =>
      Effect.gen(function* () {
        const sessionDataDir = yield* Effect.promise(() => makeTempDir());
        yield* Effect.promise(() =>
          writeFile(join(sessionDataDir, "Partitions"), "not a directory"),
        );
        yield* Effect.gen(function* () {
          const sessions = yield* GameSessions;
          expect(
            yield* sessions.acquireGamePartition({ kind: "default" }),
          ).toBe("persist:lucent-game-default");
          const error = yield* sessions.clearAppData.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ElectronSessionDataClearError",
            cause: { code: "ENOTDIR" },
          });
        }).pipe(Effect.scoped, Effect.provide(testLayer(sessionDataDir)));
      }),
  );
  it.effect("remains usable after startup cannot remove a stale profile", () =>
    Effect.gen(function* () {
      const sessionDataDir = yield* Effect.promise(() => makeTempDir());
      const profilePath = join(
        sessionDataDir,
        "Partitions",
        "lucent-game-temporary-2147483647-aaaaaaaaaaaaaaaaaaaaaaaa",
      );
      yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
      const fileSystem = yield* makeFileSystem();
      const partition = yield* Effect.gen(function* () {
        const sessions = yield* GameSessions;
        return yield* sessions.acquireGamePartition({ kind: "default" });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(sessionDataDir, {
            ...fileSystem,
            remove: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: path,
                }),
              ),
          }),
        ),
      );
      expect(partition).toBe("persist:lucent-game-default");
      expect(
        (yield* Effect.promise(() => stat(profilePath))).isDirectory(),
      ).toBe(true);
    }),
  );
});
const makePartitionLifecycle = Effect.fnUntraced(function* (
  first: "acquire" | "retire",
) {
  const sessionDataDir = yield* Effect.promise(() => makeTempDir());
  const profilePath = join(
    sessionDataDir,
    "Partitions",
    managedPartition.slice("persist:".length),
  );
  const markerPath = join(profilePath, ".lucent-retired");
  const fileSystem = yield* makeFileSystem();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const trace: string[] = [];
  const track = (
    operation: "acquire" | "retire",
    effect: Effect.Effect<void, PlatformError.PlatformError>,
  ) =>
    Effect.gen(function* () {
      trace.push(operation);
      if (operation === first) {
        started.resolve();
        yield* Effect.promise(() => finish.promise);
      }
      yield* effect;
    });
  const context = yield* Layer.build(
    testLayer(sessionDataDir, {
      ...fileSystem,
      exists: () => Effect.succeed(true),
      remove: (path, options) =>
        track("acquire", fileSystem.remove(path, options)),
      writeFileString: (path, data) =>
        track("retire", fileSystem.writeFileString(path, data)),
    }),
  );
  const sessions = Context.get(context, GameSessions);
  yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
  yield* Effect.promise(() => writeFile(markerPath, "1\n"));
  return {
    acquire: sessions.acquireGamePartition({
      kind: "managed-account",
      key: " ALICE ",
    }),
    retire: sessions.retireManagedGameProfile("alice"),
    markerPath,
    started: Effect.promise(() => started.promise),
    release: () => finish.resolve(),
    trace,
  };
});
describe("game partition lifecycle", () => {
  it.effect("serializes acquisition before concurrent retirement", () =>
    Effect.gen(function* () {
      const { acquire, retire, markerPath, started, release, trace } =
        yield* makePartitionLifecycle("acquire");
      yield* Effect.gen(function* () {
        const acquisition = yield* acquire.pipe(Effect.forkChild);
        yield* started;
        const retirement = yield* retire.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(trace).toEqual(["acquire"]);
        release();
        expect(yield* Fiber.join(acquisition)).toBe(managedPartition);
        yield* Fiber.join(retirement);
        expect(trace).toEqual(["acquire", "retire"]);
        expect(yield* Effect.promise(() => readFile(markerPath, "utf8"))).toBe(
          "1\n",
        );
      }).pipe(Effect.ensuring(Effect.sync(release)));
    }).pipe(Effect.scoped),
  );
  it.effect("serializes retirement before concurrent acquisition", () =>
    Effect.gen(function* () {
      const { acquire, retire, markerPath, started, release, trace } =
        yield* makePartitionLifecycle("retire");
      yield* Effect.gen(function* () {
        const retirement = yield* retire.pipe(Effect.forkChild);
        yield* started;
        const acquisition = yield* acquire.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(trace).toEqual(["retire"]);
        release();
        yield* Fiber.join(retirement);
        expect(yield* Fiber.join(acquisition)).toBe(managedPartition);
        expect(trace).toEqual(["retire", "acquire"]);
        yield* Effect.promise(() =>
          expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" }),
        );
      }).pipe(Effect.ensuring(Effect.sync(release)));
    }).pipe(Effect.scoped),
  );
  it.effect(
    "finishes interrupted retirement before concurrent acquisition",
    () =>
      Effect.gen(function* () {
        const { acquire, retire, markerPath, started, release, trace } =
          yield* makePartitionLifecycle("retire");
        yield* Effect.gen(function* () {
          const retirement = yield* retire.pipe(Effect.forkChild);
          yield* started;
          const interrupting = yield* Fiber.interrupt(retirement).pipe(
            Effect.forkChild,
          );
          const acquisition = yield* acquire.pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(trace).toEqual(["retire"]);
          release();
          yield* Fiber.join(interrupting);
          expect(yield* Fiber.join(acquisition)).toBe(managedPartition);
          expect(trace).toEqual(["retire", "acquire"]);
          yield* Effect.promise(() =>
            expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" }),
          );
        }).pipe(Effect.ensuring(Effect.sync(release)));
      }).pipe(Effect.scoped),
  );
  it.effect(
    "maps marker failures and releases a failed acquisition lease",
    () =>
      Effect.gen(function* () {
        const sessionDataDir = yield* Effect.promise(() => makeTempDir());
        const profilePath = join(
          sessionDataDir,
          "Partitions",
          managedPartition.slice("persist:".length),
        );
        yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
        const markerPath = join(profilePath, ".lucent-retired");
        yield* Effect.gen(function* () {
          const sessions = yield* GameSessions;
          yield* Effect.promise(() => mkdir(markerPath));
          const error = yield* Effect.scoped(
            sessions.acquireGamePartition({
              kind: "managed-account",
              key: "alice",
            }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ElectronGamePartitionError",
            partition: managedPartition,
            cause: { reason: { pathOrDescriptor: markerPath } },
          });
          const retirementError = yield* sessions
            .retireManagedGameProfile("alice")
            .pipe(Effect.flip);
          expect(retirementError).toMatchObject({
            _tag: "ElectronGamePartitionError",
            partition: managedPartition,
          });
          expect(
            (yield* Effect.promise(() => stat(markerPath))).isDirectory(),
          ).toBe(true);
          yield* Effect.promise(() => rm(markerPath, { recursive: true }));
          expect(
            yield* sessions.acquireGamePartition({
              kind: "managed-account",
              key: "alice",
            }),
          ).toBe(managedPartition);
        }).pipe(Effect.scoped, Effect.provide(testLayer(sessionDataDir)));
      }),
  );
  it.effect(
    "clears discovered unopened profiles and active sessions once",
    () =>
      Effect.gen(function* () {
        const sessionDataDir = yield* Effect.promise(() => makeTempDir());
        const profilePath = join(
          sessionDataDir,
          "Partitions",
          managedPartition.slice("persist:".length),
        );
        yield* Effect.promise(() => mkdir(profilePath, { recursive: true }));
        const cleared: string[] = [];
        yield* Effect.gen(function* () {
          const sessions = yield* GameSessions;
          expect(
            yield* sessions.acquireGamePartition({ kind: "default" }),
          ).toBe("persist:lucent-game-default");
          yield* sessions.clearAppData;
        }).pipe(
          Effect.scoped,
          Effect.provide(testLayer(sessionDataDir, undefined, cleared)),
        );
        expect(cleared.toSorted()).toEqual([
          managedPartition,
          "persist:lucent-game-default",
        ]);
      }),
  );
});
describe("clearing session data", () => {
  it.effect("clears each distinct session once", () =>
    Effect.gen(function* () {
      const cleared: number[] = [];
      const sessions = Array.from({ length: 12 }, (_, id) => ({
        clearData: async () => {
          cleared.push(id);
        },
      }));
      yield* clearSessionData([...sessions, sessions[0]!]);
      expect(cleared.toSorted((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
    }),
  );
  it.effect(
    "finishes every session and reports all failures with bounded concurrency",
    () =>
      Effect.gen(function* () {
        const attempted: number[] = [];
        const completed: number[] = [];
        const firstFailure = new Error("First profile failed");
        const lastFailure = new Error("Last profile failed");
        let active = 0;
        let peak = 0;
        const sessions = Array.from({ length: 12 }, (_, id) => ({
          clearData: async () => {
            attempted.push(id);
            active += 1;
            peak = Math.max(peak, active);
            try {
              if (id === 0) throw firstFailure;
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (id === 11) throw lastFailure;
              completed.push(id);
            } finally {
              active -= 1;
            }
          },
        }));
        const error = yield* clearSessionData(sessions).pipe(Effect.flip);
        expect(attempted.toSorted((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        ]);
        expect(completed.toSorted((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
        expect(active).toBe(0);
        expect(peak).toBeLessThanOrEqual(4);
        expect(error.cause).toEqual([firstFailure, lastFailure]);
      }),
  );
});
