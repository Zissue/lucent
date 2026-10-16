import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type { AccountLaunchWindowTarget } from "@lucent/core/accounts";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import {
  AccountGameWindows,
  type AccountGameWindowEvent,
} from "./AccountGameWindows";
import * as AccountRepository from "./AccountRepository";
import { Accounts, layer as accountsLayer } from "./Accounts";
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
  readonly beforeOpen?: () => Effect.Effect<void, unknown>;
  readonly onManagedProfileKey?: (key: string | undefined) => void;
  readonly onRetireProfile?: (key: string) => void;
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
        Effect.sync(() => harnessOptions.onRetireProfile?.(key)),
      setName: (gameWindowId, name) =>
        Effect.sync(() => harnessOptions.onSetName?.(gameWindowId, name)),
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
            desktopFileSystemLayer,
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
