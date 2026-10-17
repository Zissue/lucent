import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FileSystem } from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type {
  AccountLaunchWindowTarget,
  AccountManagerState,
} from "@lucent/core/accounts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import {
  AccountGameWindows,
  type AccountGameWindowEvent,
} from "./AccountGameWindows";
import * as AccountRepository from "./AccountRepository";
import { retireManagedGamePartitionProfile } from "../session/GamePartitions";
import { Accounts, layer as accountsLayer, makeAccounts } from "./Accounts";
import { AccountsError } from "./AccountsError";
import { AccountServers } from "./AccountServers";
import * as AccountSessions from "./AccountSessions";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

interface HarnessOptions {
  readonly wrapFileSystem?: (fs: FileSystem) => FileSystem;
  readonly beforeSetName?: () => Effect.Effect<void, unknown>;
  readonly beforeOpen?: () => Effect.Effect<void, unknown>;
  readonly onManagedProfileKey?: (key: string | undefined) => void;
  readonly onRetireProfile?: (key: string) => void;
  readonly beforeRetireProfile?: () => Effect.Effect<void, unknown>;
  readonly onSetName?: (gameWindowId: number, name: string) => void;
  readonly onWindowTarget?: (
    windowTarget: AccountLaunchWindowTarget | undefined,
  ) => void;
}

const makeHarness = (harnessOptions: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "lucent-accounts-data-")),
    );
    tempDirs.add(appDataDir);
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir: join(appDataDir, "workspace"),
    });
    const closedListeners = new Set<
      (gameWindowId: number) => Effect.Effect<void, unknown>
    >();
    const createdListeners = new Set<
      (event: AccountGameWindowEvent) => Effect.Effect<void, unknown>
    >();
    const reloadedListeners = new Set<
      (event: AccountGameWindowEvent) => Effect.Effect<void, unknown>
    >();
    let nextWindowId = 1;
    const gameWindows = AccountGameWindows.of({
      close: (gameWindowId) =>
        Effect.forEach(
          [...closedListeners],
          (listener) => listener(gameWindowId),
          { discard: true },
        ).pipe(Effect.as(true)),
      getGeneration: () => Effect.succeed(1),
      getGroupId: () => Effect.succeed(1),
      onClosed: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            closedListeners.add(listener);
          }),
          () =>
            Effect.sync(() => {
              closedListeners.delete(listener);
            }),
        ),
      onCreated: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            createdListeners.add(listener);
          }),
          () =>
            Effect.sync(() => {
              createdListeners.delete(listener);
            }),
        ),
      onReloaded: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            reloadedListeners.add(listener);
          }),
          () =>
            Effect.sync(() => {
              reloadedListeners.delete(listener);
            }),
        ),
      open: (openOptions) =>
        Effect.gen(function* () {
          if (harnessOptions.beforeOpen !== undefined)
            yield* harnessOptions.beforeOpen();
          yield* Effect.sync(() => {
            harnessOptions.onManagedProfileKey?.(
              openOptions?.managedProfileKey,
            );
            harnessOptions.onWindowTarget?.(openOptions?.windowTarget);
          });
          const gameWindowId = nextWindowId++;
          const event = {
            gameWindowGroupId: 1,
            gameWindowId,
            rendererGeneration: 1,
          };
          yield* Effect.forEach(
            [...createdListeners],
            (listener) => listener(event),
            { discard: true },
          );
          if (openOptions?.onCreated !== undefined) {
            yield* openOptions.onCreated(event);
          }
          return gameWindowId;
        }),
      reveal: () => Effect.succeed(true),
      retireProfile: (key) =>
        (harnessOptions.beforeRetireProfile?.() ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => harnessOptions.onRetireProfile?.(key)),
          ),
        ),
      setName: (gameWindowId, name) =>
        (harnessOptions.beforeSetName?.() ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => harnessOptions.onSetName?.(gameWindowId, name)),
          ),
        ),
    });
    const servers = AccountServers.of({
      get: Effect.succeed({ refreshAvailableAt: 0, servers: [] }),
      getPings: Effect.succeed({ expiresAt: 0, measuredAt: 0, pings: [] }),
      refresh: Effect.succeed({ refreshAvailableAt: 0, servers: [] }),
    });
    const dependencies = Layer.mergeAll(
      AccountRepository.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment, env),
            Layer.effect(
              FileSystem,
              Effect.map(
                FileSystem,
                harnessOptions.wrapFileSystem ?? ((fs) => fs),
              ),
            ).pipe(Layer.provide(desktopFileSystemLayer)),
          ),
        ),
      ),
      AccountSessions.layer,
      Layer.succeed(AccountGameWindows, gameWindows),
      Layer.succeed(AccountServers, servers),
    );

    return accountsLayer.pipe(Layer.provideMerge(dependencies));
  });

describe("Accounts", () => {
  it.effect("records window sessions when account storage cannot load", () =>
    Effect.gen(function* () {
      let unreadablePath: string | undefined;
      const layer = yield* makeHarness({
        wrapFileSystem: (fileSystem) =>
          FileSystem.of({
            ...fileSystem,
            stream: (path, options) =>
              path === unreadablePath
                ? Stream.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stream",
                      pathOrDescriptor: path,
                    }),
                  )
                : fileSystem.stream(path, options),
          }),
      });
      return yield* Effect.gen(function* () {
        const accounts = yield* Accounts;
        const gameWindows = yield* AccountGameWindows;
        const repository = yield* AccountRepository.AccountRepository;
        const sessions = yield* AccountSessions.AccountSessions;
        const connections: string[][] = [];
        yield* accounts.onChanged((state) => {
          connections.push(
            state.sessions.map((session) => session.connection.state),
          );
        });
        const source =
          '{"accounts":[{"label":"Hero","username":"Hero","password":"secret"}],"groups":{}}';
        yield* Effect.promise(() => writeFile(repository.path, source));
        unreadablePath = repository.path;
        let gameWindowId = -1;
        try {
          gameWindowId = yield* gameWindows
            .open()
            .pipe(Effect.orElseSucceed(() => -1));

          expect(sessions.snapshot()).toMatchObject([
            {
              gameWindowGroupId: 1,
              gameWindowId: 1,
              rendererGeneration: 1,
              connection: { state: "offline" },
            },
          ]);
          expect(gameWindowId).toBe(1);
          expect(connections).toEqual([]);
          expect(yield* Effect.flip(accounts.getState)).toBeInstanceOf(
            AccountsError,
          );

          expect(
            yield* accounts
              .createAccount({ username: "New", password: "new" })
              .pipe(Effect.flip),
          ).toMatchObject({
            _tag: "AccountsError",
            operation: "read",
          });
        } finally {
          unreadablePath = undefined;
        }
        expect(
          yield* Effect.promise(() => readFile(repository.path, "utf8")),
        ).toBe(source);
        yield* accounts.reportSession(gameWindowId, {
          rendererGeneration: 1,
          revision: 1,
          runtime: {
            connection: { state: "online", username: "Alice" },
            login: { state: "idle" },
            script: { state: "idle" },
          },
        });

        expect((yield* accounts.getState).sessions).toMatchObject([
          {
            gameWindowId: 1,
            connection: { state: "online", username: "Alice" },
          },
        ]);
        expect(connections).toEqual([["online"]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each(["first", "overlapping"] as const)(
    "publishes a committed %s session report once even when interrupted",
    (operation) =>
      Effect.gen(function* () {
        const renamed = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        const layer = yield* makeHarness({
          beforeSetName: () =>
            Deferred.succeed(renamed, undefined).pipe(
              Effect.andThen(Deferred.await(hold)),
            ),
        });
        return yield* Effect.gen(function* () {
          const accounts = yield* Accounts;
          const sessions = yield* AccountSessions.AccountSessions;
          const gameWindowId = 42;
          sessions.openWindow(gameWindowId, 1, 1);
          const connections: string[] = [];
          yield* accounts.onChanged((state) => {
            connections.push(state.sessions[0]?.connection.state ?? "missing");
          });
          const report = {
            rendererGeneration: 1,
            revision: 1,
            runtime: {
              connection: { state: "online", username: "Alice" },
              login: { state: "idle" },
              script: { state: "idle" },
            },
          } as const;
          const running = yield* accounts
            .reportSession(gameWindowId, report)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(renamed);
          expect((yield* accounts.getState).sessions[0]?.connection).toEqual({
            state: "online",
            username: "Alice",
          });
          if (operation === "overlapping") {
            yield* Effect.flip(
              accounts.createAccount({ username: "", password: "secret" }),
            );
          }
          yield* Fiber.interrupt(running);
          expect(connections).toEqual(["online"]);
          yield* accounts.reportSession(gameWindowId, report);
          yield* accounts.closeGameWindow(gameWindowId);
          expect(connections).toEqual(["online", "missing"]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "keeps sessions responsive and queued writes cancellable during a write",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const layer = yield* makeHarness();
        return yield* Effect.gen(function* () {
          const accounts = yield* Accounts;
          const repository = yield* AccountRepository.AccountRepository;
          const sessions = yield* AccountSessions.AccountSessions;
          const names: string[][] = [];
          const connections: string[][] = [];
          yield* accounts.onChanged((state) => {
            names.push(state.accounts.map((account) => account.username));
            connections.push(
              state.sessions.map((session) => session.connection.state),
            );
          });
          yield* accounts.createAccount({
            username: "Before",
            password: "secret",
          });
          const active = yield* repository
            .update((storage) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(storage),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          const waiting = yield* Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(
              accounts.createAccount({
                username: "Cancelled",
                password: "secret",
              }),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(queued);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(waiting);
          expect(names).toEqual([["Before"]]);
          sessions.openWindow(42, 1, 1);
          yield* accounts.reportSession(42, {
            rendererGeneration: 1,
            revision: 1,
            runtime: {
              connection: { state: "online", username: "Before" },
              login: { state: "idle" },
              script: { state: "idle" },
            },
          });
          expect(connections).toEqual([[], ["online"]]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(active);
          yield* accounts.createAccount({
            username: "After",
            password: "secret",
          });
          expect(names).toEqual([["Before"], ["Before"], ["Before", "After"]]);
          expect(connections).toEqual([[], ["online"], ["online"]]);
          expect(
            (yield* accounts.getState).accounts.map(
              (account) => account.username,
            ),
          ).toEqual(["Before", "After"]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("publishes nothing for unchanged storage or ignored sessions", () =>
    Effect.gen(function* () {
      const layer = yield* makeHarness();
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      const names: string[][] = [];
      yield* accounts.onChanged((state) => {
        names.push(state.accounts.map((account) => account.username));
      });
      yield* accounts.load;
      yield* accounts.deleteAccounts([]);
      yield* Effect.flip(
        accounts.createAccount({ username: "", password: "secret" }),
      );
      expect(names).toEqual([]);
      yield* accounts.createAccount({ username: "Alice", password: "secret" });
      yield* accounts.updateAccount("Alice", {});
      yield* accounts.deleteAccounts([]);
      yield* accounts.load;
      yield* accounts.reportSession(42, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "offline" },
          login: { state: "idle" },
          script: { state: "idle" },
        },
      });
      yield* Effect.flip(
        accounts.createAccount({ username: "Alice", password: "secret" }),
      );
      expect(names).toEqual([["Alice"]]);
      const storagePath = (yield* accounts.getState).storagePath;
      yield* Effect.promise(() =>
        writeFile(
          storagePath,
          '{"accounts":[{"label":"Bob","username":"Bob","password":"secret"}],"groups":{}}',
        ),
      );
      yield* accounts.load;
      yield* accounts.load;
      expect(names).toEqual([["Alice"], ["Bob"]]);
    }),
  );

  it.effect("allows a listener to commit a successive mutation", () =>
    Effect.gen(function* () {
      const layer = yield* makeHarness();
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      const names: string[][] = [];
      yield* accounts.onChanged((state) =>
        Effect.gen(function* () {
          names.push(state.accounts.map((account) => account.username));
          if (names.length === 1) {
            yield* accounts.createAccount({
              username: "Bob",
              password: "secret",
            });
          }
        }),
      );
      const laterNames: string[][] = [];
      yield* accounts.onChanged((state) => {
        laterNames.push(state.accounts.map((account) => account.username));
      });
      yield* accounts.createAccount({ username: "Alice", password: "secret" });
      expect(laterNames).toEqual([["Alice", "Bob"]]);
      expect(names).toEqual([["Alice"], ["Alice", "Bob"]]);
      expect(
        (yield* accounts.getState).accounts.map((account) => account.username),
      ).toEqual(["Alice", "Bob"]);
    }),
  );

  it.effect(
    "reopens with current credentials and the original server, with scripts stopped",
    () =>
      Effect.gen(function* () {
        const targets: (AccountLaunchWindowTarget | undefined)[] = [];
        const layer = yield* makeHarness({
          onWindowTarget: (target) => targets.push(target),
        });
        return yield* Effect.gen(function* () {
          const accounts = yield* Accounts;
          const sessions = yield* AccountSessions.AccountSessions;
          sessions.openWindow(77, 1, 1);
          yield* accounts.createAccount({ username: "Alice", password: "old" });
          const original = yield* accounts.launch({
            username: "Alice",
            server: "Artix",
            script: { name: "farm.js", path: "/scripts/farm.js" },
          });
          yield* accounts.closeGameWindow(original.gameWindowId);
          const wrongWindow = yield* Effect.flip(
            accounts.reopenGameWindow({
              id: original.gameWindowId,
              gameWindowGroupId: 2,
              windowTarget: { kind: "same-as-game", gameWindowId: 77 },
            }),
          );
          expect(wrongWindow.message).toBe(
            "This tab is no longer available to reopen.",
          );
          expect(yield* accounts.getRecentlyClosed(2)).toEqual([]);
          expect(
            (yield* accounts.getRecentlyClosed(1)).map(
              ({ username, server }) => ({ username, server }),
            ),
          ).toEqual([{ username: "Alice", server: "Artix" }]);
          yield* accounts.updateAccount("Alice", { password: "new" });
          const reopened = yield* accounts.reopenGameWindow({
            id: original.gameWindowId,
            gameWindowGroupId: 1,
            windowTarget: { kind: "same-as-game", gameWindowId: 77 },
          });
          const payload = yield* accounts.getGameLaunch(reopened.gameWindowId);
          expect(payload?.account).toEqual({
            label: "Alice",
            username: "Alice",
            password: "new",
          });
          expect(payload?.server).toBe("Artix");
          expect(payload).not.toHaveProperty("script");
          expect(targets).toEqual([
            undefined,
            { kind: "same-as-game", gameWindowId: 77 },
          ]);
          expect(yield* accounts.getRecentlyClosed(1)).toEqual([]);
          const stale = yield* Effect.flip(
            accounts.reopenGameWindow({
              id: original.gameWindowId,
              gameWindowGroupId: 1,
              windowTarget: { kind: "new" },
            }),
          );
          expect(stale.message).toBe(
            "This tab is no longer available to reopen.",
          );
          expect(
            (yield* accounts.getState).sessions
              .map((session) => session.gameWindowId)
              .toSorted((a, b) => a - b),
          ).toEqual([2, 77]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("keeps a closed tab available after a failed reopen", () =>
    Effect.gen(function* () {
      let failOpen = false;
      const layer = yield* makeHarness({
        beforeOpen: () =>
          failOpen ? Effect.fail(new Error("Window unavailable")) : Effect.void,
      });
      return yield* Effect.gen(function* () {
        const accounts = yield* Accounts;
        const sessions = yield* AccountSessions.AccountSessions;
        sessions.openWindow(77, 1, 1);
        yield* accounts.createAccount({
          username: "Alice",
          password: "secret",
        });
        const original = yield* accounts.launch({ username: "Alice" });
        yield* accounts.closeGameWindow(original.gameWindowId);
        failOpen = true;
        yield* Effect.flip(
          accounts.reopenGameWindow({
            id: original.gameWindowId,
            gameWindowGroupId: 1,
            windowTarget: { kind: "new" },
          }),
        );
        expect(
          (yield* accounts.getRecentlyClosed(1)).map((entry) => entry.id),
        ).toEqual([1]);
        failOpen = false;
        const reopened = yield* accounts.reopenGameWindow({
          id: original.gameWindowId,
          gameWindowGroupId: 1,
          windowTarget: { kind: "new" },
        });
        expect(reopened).toEqual({ gameWindowId: 2 });
        expect(yield* accounts.getRecentlyClosed(1)).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "does not reopen one history entry twice while a launch is pending",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let pause = false;
        const layer = yield* makeHarness({
          beforeOpen: () =>
            pause
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                )
              : Effect.void,
        });
        return yield* Effect.gen(function* () {
          const accounts = yield* Accounts;
          const sessions = yield* AccountSessions.AccountSessions;
          sessions.openWindow(77, 1, 1);
          yield* accounts.createAccount({
            username: "Alice",
            password: "secret",
          });
          const original = yield* accounts.launch({ username: "Alice" });
          yield* accounts.closeGameWindow(original.gameWindowId);
          pause = true;
          const request = {
            id: original.gameWindowId,
            gameWindowGroupId: 1,
            windowTarget: { kind: "same-as-game", gameWindowId: 77 },
          } as const;
          const first = yield* Effect.forkChild(
            accounts.reopenGameWindow(request),
          );
          yield* Deferred.await(started);
          const duplicate = yield* Effect.flip(
            accounts.reopenGameWindow(request),
          );
          expect(duplicate.message).toBe(
            "This tab is no longer available to reopen.",
          );
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(first)).toEqual({ gameWindowId: 2 });
          expect(
            (yield* accounts.getState).sessions
              .map((session) => session.gameWindowId)
              .toSorted((a, b) => a - b),
          ).toEqual([2, 77]);
          expect(yield* accounts.getRecentlyClosed(1)).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("reopens deleted accounts at the login screen", () =>
    Effect.gen(function* () {
      const layer = yield* makeHarness();
      return yield* Effect.gen(function* () {
        const accounts = yield* Accounts;
        const sessions = yield* AccountSessions.AccountSessions;
        sessions.openWindow(77, 1, 1);
        yield* accounts.createAccount({
          username: "Alice",
          password: "secret",
        });
        const original = yield* accounts.launch({ username: "Alice" });
        yield* accounts.closeGameWindow(original.gameWindowId);
        yield* accounts.deleteAccount("Alice");
        const reopened = yield* accounts.reopenGameWindow({
          id: original.gameWindowId,
          gameWindowGroupId: 1,
          windowTarget: { kind: "new" },
        });
        expect(
          (yield* accounts.getState).sessions.filter(
            (session) => session.gameWindowId !== 77,
          ),
        ).toMatchObject([
          {
            gameWindowId: reopened.gameWindowId,
            connection: { state: "offline" },
            login: { state: "idle" },
            script: { state: "idle" },
          },
        ]);
        expect(yield* accounts.getGameLaunch(reopened.gameWindowId)).toBeNull();
        expect(yield* accounts.getRecentlyClosed(1)).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists account and group mutations", () =>
    Effect.gen(function* () {
      const layer = yield* makeHarness();
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      yield* accounts.createAccount({
        username: "Alice",
        password: "secret",
      });
      const state = yield* accounts.createGroup({
        name: "Party",
        usernames: ["Alice"],
      });

      expect(state.accounts).toEqual([
        { label: "Alice", password: "secret", username: "Alice" },
      ]);
      expect(state.groups).toEqual({ Party: ["Alice"] });

      const error = yield* Effect.flip(
        accounts.createAccount({
          username: "alice",
          password: "other",
        }),
      );
      expect(error).toBeInstanceOf(AccountsError);
    }),
  );

  it.effect("deletes multiple accounts and group memberships atomically", () =>
    Effect.gen(function* () {
      const retiredProfiles: string[] = [];
      const layer = yield* makeHarness({
        onRetireProfile: (key) => retiredProfiles.push(key),
      });
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      for (const username of ["Alice", "Bob", "Cara"]) {
        yield* accounts.createAccount({ password: "secret", username });
      }
      yield* accounts.createGroup({
        name: "Party",
        usernames: ["Alice", "Bob", "Cara"],
      });

      yield* Effect.flip(accounts.deleteAccounts(["Alice", "Missing"]));
      expect((yield* accounts.getState).accounts).toHaveLength(3);
      expect(retiredProfiles).toEqual([]);

      const state = yield* accounts.deleteAccounts(["Alice", "Bob"]);

      expect(state.accounts.map((account) => account.username)).toEqual([
        "Cara",
      ]);
      expect(state.groups).toEqual({ Party: ["Cara"] });
      expect(retiredProfiles).toEqual(["Alice", "Bob"]);
    }),
  );

  it.effect("retires the old profile after an account username changes", () =>
    Effect.gen(function* () {
      const retiredProfiles: string[] = [];
      const layer = yield* makeHarness({
        onRetireProfile: (key) => retiredProfiles.push(key),
      });
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      yield* accounts.createAccount({
        username: "Alice",
        password: "secret",
      });

      yield* accounts.updateAccount("Alice", { username: "Alicia" });
      yield* accounts.updateAccount("Alicia", { username: "ALICIA" });

      expect(retiredProfiles).toEqual(["Alice"]);
    }),
  );

  it.effect("tracks launch intent separately from reported runtime", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1234567890000);
      const managedProfileKeys: Array<string | undefined> = [];
      const windowTargets: Array<AccountLaunchWindowTarget | undefined> = [];
      const layer = yield* makeHarness({
        onManagedProfileKey: (key) => managedProfileKeys.push(key),
        onWindowTarget: (windowTarget) => windowTargets.push(windowTarget),
      });
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      yield* accounts.createAccount({
        username: "Alice",
        password: "secret",
      });
      const launch = yield* accounts.launch({
        username: "Alice",
        script: { name: "farm.js", path: "/scripts/farm.js" },
        windowTarget: { kind: "new" },
      });
      const payload = yield* accounts.getGameLaunch(launch.gameWindowId);
      expect(payload?.requestedAt).toBe(1234567890000);
      expect(payload?.account.username).toBe("Alice");
      expect(payload?.script).toEqual({
        name: "farm.js",
        path: "/scripts/farm.js",
      });
      expect(managedProfileKeys).toEqual(["Alice"]);
      expect(windowTargets).toEqual([{ kind: "new" }]);

      yield* accounts.reportSession(launch.gameWindowId, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "online", username: "Alice" },
          login: { state: "idle" },
          script: { name: "farm.js", state: "running" },
        },
      });
      expect((yield* accounts.getState).sessions[0]).toMatchObject({
        connection: { state: "online", username: "Alice" },
        gameWindowGroupId: 1,
        gameWindowId: launch.gameWindowId,
        script: { name: "farm.js", state: "running" },
      });

      const closed = yield* accounts.closeGameWindow(launch.gameWindowId);
      expect(closed.sessions).toEqual([]);
      expect(yield* accounts.getGameLaunch(launch.gameWindowId)).toBeNull();
    }),
  );

  it.effect("does not create a session from an untracked renderer report", () =>
    Effect.gen(function* () {
      const layer = yield* makeHarness();
      const accounts = yield* Accounts.pipe(Effect.provide(layer));

      yield* accounts.reportSession(42, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "online", username: "DirectPlayer" },
          login: { state: "idle" },
          script: { state: "idle" },
        },
      });

      expect((yield* accounts.getState).sessions).toEqual([]);
    }),
  );

  it.effect("clears identity on logout and ignores an older report", () =>
    Effect.gen(function* () {
      const names: Array<{ readonly id: number; readonly name: string }> = [];
      const layer = yield* makeHarness({
        onSetName: (id, name) => names.push({ id, name }),
      });
      const accounts = yield* Accounts.pipe(Effect.provide(layer));
      yield* accounts.createAccount({
        password: "secret",
        username: "Alice",
      });
      const launch = yield* accounts.launch({ username: "Alice" });

      yield* accounts.reportSession(launch.gameWindowId, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "online", username: "DirectPlayer" },
          login: { state: "idle" },
          script: { state: "idle" },
        },
      });
      yield* accounts.reportSession(launch.gameWindowId, {
        rendererGeneration: 1,
        revision: 2,
        runtime: {
          connection: {
            lastUsername: "DirectPlayer",
            state: "offline",
          },
          login: { state: "idle" },
          script: { message: "Stopped", state: "stopped" },
        },
      });
      yield* accounts.reportSession(launch.gameWindowId, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "online", username: "StalePlayer" },
          login: { state: "idle" },
          script: { state: "idle" },
        },
      });

      const [session] = (yield* accounts.getState).sessions;
      expect(session).toMatchObject({
        connection: {
          lastUsername: "DirectPlayer",
          state: "offline",
        },
        gameWindowId: launch.gameWindowId,
        script: { message: "Stopped", state: "stopped" },
      });
      expect(names).toEqual([
        { id: launch.gameWindowId, name: "DirectPlayer" },
        { id: launch.gameWindowId, name: "" },
      ]);
    }),
  );
});

describe("account profile retirement logging", () => {
  it.effect(
    "aggregates failures per mutation without identities and keeps success silent",
    () =>
      Effect.gen(function* () {
        const records: DesktopLogRecord[] = [];
        let fail = true;
        const layer = yield* makeHarness({
          beforeRetireProfile: () =>
            fail
              ? Effect.fail(new Error("profile cleanup failed"))
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const accounts = yield* Accounts;
          for (const username of ["Alice", "Bob", "Cara"])
            yield* accounts.createAccount({ username, password: "secret" });
          expect(
            (yield* accounts.deleteAccounts(["Alice", "Bob"])).accounts.map(
              (account) => account.username,
            ),
          ).toEqual(["Cara"]);
          expect(records).toMatchObject([
            {
              level: "warn",
              message: "Failed to retire game profiles",
              component: "accounts",
              data: { count: 2 },
              error: [
                { message: "profile cleanup failed" },
                { message: "profile cleanup failed" },
              ],
            },
          ]);
          expect(records[0]?.data).toEqual({ count: 2 });
          fail = false;
          expect((yield* accounts.deleteAccount("Cara")).accounts).toEqual([]);
          expect(records).toHaveLength(1);
        }).pipe(
          Effect.provide(layer),
          Effect.provide(
            Logger.layer(
              [
                Logger.make((options) =>
                  records.push(desktopLogRecord(options)),
                ),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
      }),
  );
});

it.effect("keeps missing game profiles silent after account removal", () =>
  Effect.gen(function* () {
    const records: DesktopLogRecord[] = [];
    const fileSystem = yield* FileSystem.pipe(
      Effect.provide(desktopFileSystemLayer),
    );
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "lucent-missing-profile-")),
    );
    tempDirs.add(root);
    const layer = yield* makeHarness({
      beforeRetireProfile: () =>
        Effect.gen(function* () {
          expect(
            yield* retireManagedGamePartitionProfile(
              join(root, "missing"),
              fileSystem,
            ),
          ).toBe(false);
        }),
    });
    yield* Effect.gen(function* () {
      const accounts = yield* Accounts;
      yield* accounts.createAccount({ username: "Alice", password: "secret" });
      expect((yield* accounts.deleteAccount("Alice")).accounts).toEqual([]);
      expect(records).toEqual([]);
    }).pipe(
      Effect.provide(layer),
      Effect.provide(
        Logger.layer(
          [Logger.make((options) => records.push(desktopLogRecord(options)))],
          { mergeWithExisting: false },
        ),
      ),
    );
  }),
);

it.effect("commits accounts interrupted after the file rename", () =>
  Effect.gen(function* () {
    let armed = false;
    const layer = yield* makeHarness({
      wrapFileSystem: (fileSystem) =>
        FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            fileSystem.rename(from, to).pipe(
              Effect.tap(() =>
                Effect.withFiber((fiber) => {
                  if (armed) {
                    armed = false;
                    fiber.interruptUnsafe();
                  }
                  return Effect.void;
                }),
              ),
            ),
        }),
    });
    yield* Effect.gen(function* () {
      const accounts = yield* Accounts;
      yield* accounts.load;
      const received: string[][] = [];
      yield* accounts.onChanged((next) => {
        received.push(next.accounts.map((account) => account.username));
      });
      armed = true;
      const running = yield* accounts
        .createAccount({ username: "Committed", password: "secret" })
        .pipe(Effect.forkChild);
      const exit = yield* Fiber.await(running);
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ _tag: "Interrupt" }] },
      });
      const current = yield* accounts.getState;
      const persisted = JSON.parse(
        yield* Effect.promise(() => readFile(current.storagePath, "utf8")),
      );
      expect(persisted.accounts).toEqual([
        { label: "Committed", username: "Committed", password: "secret" },
      ]);
      expect(current.accounts).toEqual([
        { label: "Committed", username: "Committed", password: "secret" },
      ]);
      expect(received).toEqual([["Committed"]]);
      yield* accounts.createAccount({ username: "After", password: "secret" });
      expect(
        (yield* accounts.getState).accounts.map((account) => account.username),
      ).toEqual(["Committed", "After"]);
      expect(
        JSON.parse(
          yield* Effect.promise(() => readFile(current.storagePath, "utf8")),
        ).accounts,
      ).toEqual([
        { label: "Committed", username: "Committed", password: "secret" },
        { label: "After", username: "After", password: "secret" },
      ]);
      expect(received).toEqual([["Committed"], ["Committed", "After"]]);
      expect((yield* accounts.load).accounts).toEqual([
        { label: "Committed", username: "Committed", password: "secret" },
        { label: "After", username: "After", password: "secret" },
      ]);
      expect(received).toEqual([["Committed"], ["Committed", "After"]]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "orders repository and session publications without replaying an older revision",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const layer = yield* makeHarness();
      yield* Effect.gen(function* () {
        const accounts = yield* Accounts;
        const windows = yield* AccountGameWindows;
        const repository = yield* AccountRepository.AccountRepository;
        const sessions = yield* AccountSessions.AccountSessions;
        const gameWindowId = yield* windows.open();
        const first: {
          sourceRevision: number;
          sessionRevision: number;
          names: string[];
          connection: string;
        }[] = [];
        const later: {
          sourceRevision: number;
          sessionRevision: number;
          names: string[];
          connection: string;
        }[] = [];
        const snapshot = (state: AccountManagerState) =>
          Effect.sync(() => ({
            sourceRevision:
              (repository.currentUnsafe()?.revision ?? 0) + sessions.revision,
            sessionRevision: state.sessions[0]?.revision ?? 0,
            names: state.accounts.map((account) => account.username),
            connection: state.sessions[0]?.connection.state ?? "missing",
          }));
        yield* accounts.onChanged((state) =>
          Effect.gen(function* () {
            first.push(yield* snapshot(state));
            if (first.length === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
          }),
        );
        yield* accounts.onChanged((state) =>
          snapshot(state).pipe(
            Effect.map((value) => {
              later.push(value);
            }),
          ),
        );
        const creating = yield* accounts
          .createAccount({ username: "Alice", password: "secret" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const report = {
          rendererGeneration: 1,
          revision: 1,
          runtime: {
            connection: { state: "online", username: "Alice" },
            login: { state: "idle" },
            script: { state: "idle" },
          },
        } as const;
        yield* accounts.reportSession(gameWindowId, report);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(creating);
        yield* accounts.createAccount({ username: "Bob", password: "secret" });
        yield* accounts.reportSession(gameWindowId, {
          ...report,
          revision: 2,
          runtime: { ...report.runtime, connection: { state: "offline" } },
        });
        yield* accounts.load;
        yield* accounts.reportSession(gameWindowId, report);
        expect(first).toEqual([
          {
            sourceRevision: 2,
            sessionRevision: 1,
            names: ["Alice"],
            connection: "offline",
          },
          {
            sourceRevision: 3,
            sessionRevision: 2,
            names: ["Alice"],
            connection: "online",
          },
          {
            sourceRevision: 4,
            sessionRevision: 2,
            names: ["Alice", "Bob"],
            connection: "online",
          },
          {
            sourceRevision: 5,
            sessionRevision: 3,
            names: ["Alice", "Bob"],
            connection: "offline",
          },
        ]);
        expect(later).toEqual([
          {
            sourceRevision: 3,
            sessionRevision: 2,
            names: ["Alice"],
            connection: "online",
          },
          {
            sourceRevision: 4,
            sessionRevision: 2,
            names: ["Alice", "Bob"],
            connection: "online",
          },
          {
            sourceRevision: 5,
            sessionRevision: 3,
            names: ["Alice", "Bob"],
            connection: "offline",
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "publishes coherent account storage while session reports overlap",
  () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      const reportsStarted = yield* Deferred.make<void>();
      const releaseReports = yield* Deferred.make<void>();
      let holdRead = false;
      let holdReports = false;
      let pendingReports = 0;
      const layer = yield* makeHarness({
        beforeSetName: () =>
          Effect.gen(function* () {
            if (!holdReports) return;
            pendingReports += 1;
            if (pendingReports === 2)
              yield* Deferred.succeed(reportsStarted, undefined);
            yield* Deferred.await(releaseReports);
          }),
      });
      yield* Effect.gen(function* () {
        const repository = yield* AccountRepository.AccountRepository;
        const gateRead = Effect.gen(function* () {
          if (!holdRead) return;
          holdRead = false;
          yield* Deferred.succeed(readStarted, undefined);
          yield* Deferred.await(releaseRead);
        });
        const accounts = yield* makeAccounts.pipe(
          Effect.provideService(
            AccountRepository.AccountRepository,
            AccountRepository.AccountRepository.of({
              ...repository,
              get: repository.get.pipe(Effect.tap(() => gateRead)),
            }),
          ),
        );
        const windows = yield* AccountGameWindows;
        const windowId = yield* windows.open();
        yield* accounts.createAccount({
          username: "Alice",
          password: "secret",
        });
        const received: Omit<AccountManagerState, "storagePath">[] = [];
        yield* accounts.onChanged((state) => {
          received.push({
            accounts: state.accounts,
            groups: state.groups,
            sessions: state.sessions,
          });
        });
        holdRead = true;
        const publishing = yield* accounts.load.pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        yield* accounts.createAccount({ username: "Bob", password: "secret" });
        holdReports = true;
        const firstReport = yield* accounts
          .reportSession(windowId, {
            rendererGeneration: 1,
            revision: 1,
            runtime: {
              connection: { state: "online", username: "Alice" },
              login: { state: "idle" },
              script: { state: "idle" },
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const secondReport = yield* accounts
          .reportSession(windowId, {
            rendererGeneration: 1,
            revision: 2,
            runtime: {
              connection: { state: "offline" },
              login: { state: "idle" },
              script: { state: "idle" },
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(reportsStarted);
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Fiber.join(publishing);
        yield* Deferred.succeed(releaseReports, undefined);
        yield* Fiber.join(firstReport);
        yield* Fiber.join(secondReport);
        expect(received).toEqual([
          {
            accounts: [
              { label: "Alice", username: "Alice", password: "secret" },
              { label: "Bob", username: "Bob", password: "secret" },
            ],
            groups: {},
            sessions: [
              {
                gameWindowId: 1,
                gameWindowGroupId: 1,
                rendererGeneration: 1,
                revision: 1,
                updatedAt: 0,
                connection: { state: "offline" },
                login: { state: "idle" },
                script: { state: "idle" },
              },
            ],
          },
          {
            accounts: [
              { label: "Alice", username: "Alice", password: "secret" },
              { label: "Bob", username: "Bob", password: "secret" },
            ],
            groups: {},
            sessions: [
              {
                gameWindowId: 1,
                gameWindowGroupId: 1,
                rendererGeneration: 1,
                revision: 3,
                updatedAt: 0,
                connection: { state: "offline" },
                login: { state: "idle" },
                script: { state: "idle" },
              },
            ],
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
);
