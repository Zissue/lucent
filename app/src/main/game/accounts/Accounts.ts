import * as Cause from "effect/Cause";
import { logFailure } from "../../../shared/logFailure";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  removeGroupMemberUsername,
  renameGroupMemberUsername,
  type AccountGameLaunchPayload,
  type AccountLaunchRequest,
  type AccountLaunchResult,
  type AccountLaunchWindowTarget,
  type AccountManagerState,
  type AccountManagerStorage,
  type AccountSessionReport,
  type ManagedAccount,
  type ManagedAccountDraft,
  type ManagedAccountGroupDraft,
  type ManagedAccountGroupPatch,
  type ManagedAccountGroups,
  type ManagedAccountPatch,
  type RecentlyClosedGameSession,
} from "@lucent/core/accounts";
import {
  makeListenerRegistry,
  type Listener,
} from "../../app/ListenerRegistry";
import {
  AccountGameWindows,
  type AccountGameWindowEvent,
} from "./AccountGameWindows";
import { AccountRepository } from "./AccountRepository";
import { AccountSessions, type PendingAccountLaunch } from "./AccountSessions";
import {
  AccountsError,
  accountError,
  type AccountOperation,
} from "./AccountsError";

export interface AccountsShape {
  readonly getRecentlyClosed: (
    gameWindowGroupId: number,
  ) => Effect.Effect<readonly RecentlyClosedGameSession[]>;
  readonly reopenGameWindow: (request: {
    readonly id: number;
    readonly gameWindowGroupId: number;
    readonly windowTarget: AccountLaunchWindowTarget;
  }) => Effect.Effect<AccountLaunchResult, AccountsError>;
  readonly closeGameWindows: (
    gameWindowIds: readonly number[],
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly createAccount: (
    draft: ManagedAccountDraft,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly createGroup: (
    draft: ManagedAccountGroupDraft,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly deleteAccounts: (
    usernames: readonly string[],
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly deleteGroup: (
    name: string,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly focusGameWindow: (
    gameWindowId: number,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly getGameLaunch: (
    gameWindowId: number,
  ) => Effect.Effect<AccountGameLaunchPayload | null>;
  readonly getState: Effect.Effect<AccountManagerState, AccountsError>;
  readonly launch: (
    request: AccountLaunchRequest,
  ) => Effect.Effect<AccountLaunchResult, AccountsError>;
  readonly onChanged: (
    listener: Listener<AccountManagerState>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly suppressGameWindowLaunchScript: (
    gameWindowId: number,
    message: string,
  ) => Effect.Effect<void>;
  readonly updateAccount: (
    username: string,
    patch: ManagedAccountPatch,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly updateGroup: (
    name: string,
    patch: ManagedAccountGroupPatch,
  ) => Effect.Effect<AccountManagerState, AccountsError>;
  readonly reportSession: (
    gameWindowId: number,
    report: AccountSessionReport,
  ) => Effect.Effect<void>;
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()(
  "lucent/desktop/game/accounts/Accounts",
) {}

const normalizeRequiredString = Effect.fnUntraced(function* (
  value: string,
  field: string,
  operation: AccountOperation,
): Effect.fn.Return<string, AccountsError> {
  const normalized = value.trim();
  if (normalized === "") {
    return yield* accountError(operation, `${field} is required`);
  }
  return normalized;
});

const normalizeOptionalString = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
};

const normalizeAccountDraft = Effect.fnUntraced(function* (
  draft: ManagedAccountDraft,
  operation: AccountOperation,
): Effect.fn.Return<ManagedAccount, AccountsError> {
  const username = yield* normalizeRequiredString(
    draft.username,
    "username",
    operation,
  );
  const password = yield* normalizeRequiredString(
    draft.password,
    "password",
    operation,
  );
  const label =
    draft.label !== undefined && draft.label.trim() !== ""
      ? draft.label.trim()
      : username;
  return { label, password, username };
});

const normalizeAccountPatch = Effect.fnUntraced(function* (
  patch: ManagedAccountPatch,
): Effect.fn.Return<ManagedAccountPatch, AccountsError> {
  const output: Record<string, string> = {};
  for (const key of ["label", "username", "password"] as const) {
    if (patch[key] !== undefined) {
      output[key] = yield* normalizeRequiredString(
        patch[key],
        key,
        "update-account",
      );
    }
  }
  return output;
});

const hasAccountUsername = (
  accounts: readonly ManagedAccount[],
  username: string,
  options: { readonly exceptUsername?: string } = {},
): boolean => {
  const key = username.toLowerCase();
  const exceptKey = options.exceptUsername?.toLowerCase();
  return accounts.some(
    (account) =>
      account.username.toLowerCase() === key &&
      account.username.toLowerCase() !== exceptKey,
  );
};

const findGroupName = (
  groups: ManagedAccountGroups,
  name: string,
): string | undefined => {
  const key = name.toLowerCase();
  return Object.keys(groups).find(
    (groupName) => groupName.toLowerCase() === key,
  );
};

const hasGroupName = (
  groups: ManagedAccountGroups,
  name: string,
  options: { readonly exceptName?: string } = {},
): boolean => {
  const key = name.toLowerCase();
  const exceptKey = options.exceptName?.toLowerCase();
  return Object.keys(groups).some(
    (groupName) => groupName.toLowerCase() === key && key !== exceptKey,
  );
};

const normalizeGroupMembers = Effect.fnUntraced(function* (
  value: readonly string[],
  accounts: readonly ManagedAccount[],
  operation: AccountOperation,
): Effect.fn.Return<readonly string[], AccountsError> {
  const accountUsernames = new Set(accounts.map((account) => account.username));
  const seen = new Set<string>();
  const usernames: string[] = [];
  for (const username of value) {
    const normalized = yield* normalizeRequiredString(
      username,
      "group username",
      operation,
    );
    if (!accountUsernames.has(normalized)) {
      return yield* accountError(operation, `Account not found: ${normalized}`);
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return yield* accountError(
        operation,
        `Duplicate group member: ${normalized}`,
      );
    }
    seen.add(key);
    usernames.push(normalized);
  }
  return usernames;
});

const normalizeGroupDraft = Effect.fnUntraced(function* (
  draft: ManagedAccountGroupDraft,
  accounts: readonly ManagedAccount[],
): Effect.fn.Return<ManagedAccountGroupDraft, AccountsError> {
  const name = yield* normalizeRequiredString(
    draft.name,
    "group name",
    "create-group",
  );
  const usernames = yield* normalizeGroupMembers(
    draft.usernames,
    accounts,
    "create-group",
  );
  return { name, usernames };
});

const normalizeGroupPatch = Effect.fnUntraced(function* (
  patch: ManagedAccountGroupPatch,
  accounts: readonly ManagedAccount[],
): Effect.fn.Return<ManagedAccountGroupPatch, AccountsError> {
  return {
    ...(patch.name === undefined
      ? {}
      : {
          name: yield* normalizeRequiredString(
            patch.name,
            "group name",
            "update-group",
          ),
        }),
    ...(patch.usernames === undefined
      ? {}
      : {
          usernames: yield* normalizeGroupMembers(
            patch.usernames,
            accounts,
            "update-group",
          ),
        }),
  };
});

const makeAccounts = Effect.gen(function* () {
  const gameWindows = yield* AccountGameWindows;
  const repository = yield* AccountRepository;
  const sessions = yield* AccountSessions;
  const reopening = new Set<number>();
  const getRecentlyClosed: AccountsShape["getRecentlyClosed"] = (groupId) =>
    Effect.sync(() => sessions.recentlyClosed(groupId));

  const toState = (storage: AccountManagerStorage): AccountManagerState => ({
    accounts: storage.accounts,
    groups: storage.groups,
    sessions: sessions.snapshot(),
    storagePath: repository.path,
  });

  const getState = repository.get.pipe(Effect.map(toState));

  const stateChanges = makeListenerRegistry<AccountManagerState>();
  const publicationLock = yield* Semaphore.make(1);
  const publishCurrent = Effect.suspend(() =>
    repository.current() === null
      ? repository.get.pipe(Effect.ignore)
      : Effect.void,
  ).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const current = repository.current();
        return current === null
          ? Effect.void
          : stateChanges.publish(toState(current));
      }).pipe(Semaphore.withPermit(publicationLock)),
    ),
    Effect.uninterruptible,
  );
  yield* repository.subscribe(() => publishCurrent);

  const changeSession = <A>(change: () => A) =>
    Effect.sync(change).pipe(
      Effect.tap((changed) => (changed ? publishCurrent : Effect.void)),
      Effect.uninterruptible,
    );

  const updateStorage = (
    modify: (
      storage: AccountManagerStorage,
    ) => Effect.Effect<AccountManagerStorage, AccountsError>,
  ) => repository.update(modify).pipe(Effect.map(toState));

  const retireGameProfiles = Effect.fnUntraced(function* (
    keys: Iterable<string>,
  ) {
    const failures: Cause.Cause<unknown>[] = [];
    yield* Effect.forEach(
      keys,
      (key) =>
        gameWindows.retireProfile(key).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push(Cause.fail(error));
            }),
          ),
        ),
      { discard: true },
    );
    if (failures.length === 0) return;
    yield* logFailure(
      "Failed to retire game profiles",
      Cause.fromReasons(failures.flatMap((cause) => cause.reasons)),
      { failure: "warning" },
    ).pipe(
      Effect.annotateLogs({
        component: "accounts",
        data: { count: failures.length },
      }),
    );
  });

  const removeWindowSession = (gameWindowId: number) =>
    changeSession(() => sessions.remove(gameWindowId)).pipe(Effect.asVoid);

  const registerWindowSession = (event: AccountGameWindowEvent) =>
    changeSession(() =>
      sessions.openWindow(
        event.gameWindowId,
        event.gameWindowGroupId,
        event.rendererGeneration,
      ),
    ).pipe(Effect.asVoid);

  const reloadWindowSession = (event: AccountGameWindowEvent) =>
    changeSession(() =>
      sessions.reloadWindow(
        event.gameWindowId,
        event.gameWindowGroupId,
        event.rendererGeneration,
      ),
    ).pipe(
      Effect.flatMap((changed) =>
        changed
          ? gameWindows
              .setName(event.gameWindowId, "")
              .pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    );

  yield* gameWindows.onCreated(registerWindowSession);
  yield* gameWindows.onReloaded(reloadWindowSession);

  const closeWindowSession = Effect.fn("Accounts.closeWindowSession")(
    function* (gameWindowId: number) {
      const now = yield* DateTime.now;
      yield* changeSession(() =>
        sessions.closeWindow(gameWindowId, DateTime.toEpochMillis(now)),
      );
    },
  );
  yield* gameWindows.onClosed(closeWindowSession);

  const closeGameWindows: AccountsShape["closeGameWindows"] = (
    gameWindowIds,
  ) => {
    const uniqueIds = [...new Set(gameWindowIds)];
    return Effect.forEach(uniqueIds, gameWindows.close, {
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.forEach(uniqueIds, closeWindowSession, { discard: true }),
      ),
      Effect.andThen(getState),
      Effect.mapError((cause) =>
        cause instanceof AccountsError
          ? cause
          : accountError(
              "close-game-window",
              "Failed to close game windows",
              cause,
            ),
      ),
    );
  };

  const createAccount: AccountsShape["createAccount"] = (draft) =>
    updateStorage((storage) =>
      Effect.gen(function* () {
        const account = yield* normalizeAccountDraft(draft, "create-account");
        if (hasAccountUsername(storage.accounts, account.username)) {
          return yield* accountError(
            "create-account",
            "An account with this username already exists",
          );
        }
        return { ...storage, accounts: [...storage.accounts, account] };
      }),
    );

  const createGroup: AccountsShape["createGroup"] = (draft) =>
    updateStorage((storage) =>
      Effect.gen(function* () {
        const group = yield* normalizeGroupDraft(draft, storage.accounts);
        if (hasGroupName(storage.groups, group.name)) {
          return yield* accountError(
            "create-group",
            "A group with this name already exists",
          );
        }
        return {
          ...storage,
          groups: { ...storage.groups, [group.name]: group.usernames },
        };
      }),
    );

  const deleteAccounts: AccountsShape["deleteAccounts"] = (usernames) =>
    Effect.gen(function* () {
      const requestedUsernames = new Set<string>();
      for (const username of usernames) {
        requestedUsernames.add(
          yield* normalizeRequiredString(
            username,
            "username",
            "delete-account",
          ),
        );
      }

      const state = yield* updateStorage((storage) =>
        Effect.gen(function* () {
          if (requestedUsernames.size === 0) {
            return storage;
          }

          const accounts = storage.accounts.filter(
            (account) => !requestedUsernames.has(account.username),
          );
          if (
            storage.accounts.length - accounts.length !==
            requestedUsernames.size
          ) {
            return yield* accountError(
              "delete-account",
              "One or more accounts were not found",
            );
          }
          let groups = storage.groups;
          for (const username of requestedUsernames) {
            groups = removeGroupMemberUsername(groups, username);
          }
          return { accounts, groups };
        }),
      );
      yield* retireGameProfiles(requestedUsernames);
      return state;
    });

  const deleteGroup: AccountsShape["deleteGroup"] = (name) =>
    updateStorage((storage) =>
      Effect.gen(function* () {
        const groupName = yield* normalizeRequiredString(
          name,
          "group name",
          "delete-group",
        );
        const existingName = findGroupName(storage.groups, groupName);
        if (existingName === undefined) {
          return yield* accountError("delete-group", "Group not found");
        }
        const groups: Record<string, readonly string[]> = {};
        for (const [currentName, usernames] of Object.entries(storage.groups)) {
          if (currentName !== existingName) groups[currentName] = usernames;
        }
        return { ...storage, groups };
      }),
    );

  const focusGameWindow: AccountsShape["focusGameWindow"] = (gameWindowId) =>
    gameWindows.reveal(gameWindowId).pipe(
      Effect.flatMap((revealed) =>
        revealed ? Effect.void : removeWindowSession(gameWindowId),
      ),
      Effect.flatMap(() => getState),
      Effect.mapError((cause) =>
        accountError(
          "focus-game-window",
          `Failed to focus game window: ${gameWindowId}`,
          cause,
        ),
      ),
    );

  const getGameLaunch: AccountsShape["getGameLaunch"] = (gameWindowId) =>
    Effect.sync(() => sessions.getLaunch(gameWindowId));

  const launch: AccountsShape["launch"] = (request) =>
    Effect.gen(function* () {
      const username = yield* normalizeRequiredString(
        request.username,
        "username",
        "launch",
      );
      const storage = yield* repository.get;
      const account = storage.accounts.find(
        (candidate) => candidate.username === username,
      );
      if (account === undefined) {
        return yield* accountError("launch", "Account not found");
      }
      const launchServer = normalizeOptionalString(request.server);
      const pending: PendingAccountLaunch = {
        account,
        ...(request.script === null || request.script === undefined
          ? {}
          : { script: request.script }),
        ...(launchServer === undefined ? {} : { server: launchServer }),
        requestedAt: yield* Clock.currentTimeMillis,
      };
      let gameWindowId: number | undefined;
      const resolvedGameWindowId = yield* gameWindows
        .open({
          managedProfileKey: account.username,
          name: account.username,
          ...(request.windowTarget === undefined
            ? {}
            : { windowTarget: request.windowTarget }),
          ...(request.gameViewLayout === undefined
            ? {}
            : { gameViewLayout: request.gameViewLayout }),
          onCreated: (event) =>
            changeSession(() => {
              gameWindowId = event.gameWindowId;
              sessions.openWindow(
                event.gameWindowId,
                event.gameWindowGroupId,
                event.rendererGeneration,
              );
              return sessions.trackLaunch(
                event.gameWindowId,
                event.gameWindowGroupId,
                event.rendererGeneration,
                pending,
              );
            }).pipe(Effect.asVoid),
        })
        .pipe(
          Effect.catch((cause) => {
            if (gameWindowId === undefined) return Effect.fail(cause);
            sessions.forgetClosed(gameWindowId);
            return removeWindowSession(gameWindowId).pipe(
              Effect.andThen(Effect.fail(cause)),
            );
          }),
        );
      if (sessions.getLaunch(resolvedGameWindowId) === null) {
        const [gameWindowGroupId, rendererGeneration] = yield* Effect.all([
          gameWindows.getGroupId(resolvedGameWindowId),
          gameWindows.getGeneration(resolvedGameWindowId),
        ]);
        yield* changeSession(() =>
          sessions.trackLaunch(
            resolvedGameWindowId,
            gameWindowGroupId,
            rendererGeneration,
            pending,
          ),
        );
      }
      return { gameWindowId: resolvedGameWindowId };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof AccountsError
          ? cause
          : accountError("launch", "Failed to launch account", cause),
      ),
    );

  const reopenGameWindow: AccountsShape["reopenGameWindow"] = Effect.fn(
    "Accounts.reopenGameWindow",
  )(
    function* ({ id, gameWindowGroupId, windowTarget }) {
      const entry = sessions
        .recentlyClosed(gameWindowGroupId)
        .find((candidate) => candidate.id === id);
      if (entry === undefined || reopening.has(id)) {
        return yield* accountError(
          "reopen-game-window",
          "This tab is no longer available to reopen.",
        );
      }
      reopening.add(id);
      return yield* Effect.gen(function* () {
        const storage = yield* repository.get;
        const account = storage.accounts.find(
          (candidate) =>
            candidate.username.toLowerCase() === entry.username.toLowerCase(),
        );
        const result =
          account === undefined
            ? { gameWindowId: yield* gameWindows.open({ windowTarget }) }
            : yield* launch({
                username: account.username,
                ...(entry.server === undefined ? {} : { server: entry.server }),
                windowTarget,
              });
        sessions.forgetClosed(id);
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => reopening.delete(id))));
    },
    Effect.mapError((cause) =>
      cause instanceof AccountsError
        ? cause
        : accountError(
            "reopen-game-window",
            "Unable to reopen the tab. Try again.",
            cause,
          ),
    ),
  );

  const onChanged: AccountsShape["onChanged"] = stateChanges.subscribe;

  // Renderer recovery reloads the same game client. Remove only its launch
  // script so account login can resume without immediately running the loop
  // that made the renderer unresponsive.
  const suppressGameWindowLaunchScript: AccountsShape["suppressGameWindowLaunchScript"] =
    (gameWindowId, message) =>
      changeSession(() =>
        sessions.suppressLaunchScript(gameWindowId, message),
      ).pipe(Effect.asVoid);

  const updateAccount: AccountsShape["updateAccount"] = (username, patch) =>
    Effect.gen(function* () {
      const currentUsername = yield* normalizeRequiredString(
        username,
        "username",
        "update-account",
      );
      const accountPatch = yield* normalizeAccountPatch(patch);
      const nextUsername = accountPatch.username ?? currentUsername;
      const state = yield* updateStorage((storage) =>
        Effect.gen(function* () {
          if (
            hasAccountUsername(storage.accounts, nextUsername, {
              exceptUsername: currentUsername,
            })
          ) {
            return yield* accountError(
              "update-account",
              "An account with this username already exists",
            );
          }
          let found = false;
          const accounts = storage.accounts.map((account) => {
            if (account.username !== currentUsername) return account;
            found = true;
            return {
              ...account,
              ...accountPatch,
              label: accountPatch.label ?? account.label,
            };
          });
          if (!found) {
            return yield* accountError("update-account", "Account not found");
          }
          return {
            accounts,
            groups: renameGroupMemberUsername(
              storage.groups,
              currentUsername,
              nextUsername,
            ),
          };
        }),
      );
      if (currentUsername.toLowerCase() !== nextUsername.toLowerCase()) {
        yield* retireGameProfiles([currentUsername]);
      }
      return state;
    });

  const updateGroup: AccountsShape["updateGroup"] = (name, patch) =>
    updateStorage((storage) =>
      Effect.gen(function* () {
        const currentName = yield* normalizeRequiredString(
          name,
          "group name",
          "update-group",
        );
        const existingName = findGroupName(storage.groups, currentName);
        if (existingName === undefined) {
          return yield* accountError("update-group", "Group not found");
        }
        const groupPatch = yield* normalizeGroupPatch(patch, storage.accounts);
        const nextName = groupPatch.name ?? existingName;
        if (
          hasGroupName(storage.groups, nextName, {
            exceptName: existingName,
          })
        ) {
          return yield* accountError(
            "update-group",
            "A group with this name already exists",
          );
        }
        const groups: Record<string, readonly string[]> = {};
        for (const [groupName, usernames] of Object.entries(storage.groups)) {
          groups[groupName === existingName ? nextName : groupName] =
            groupName === existingName
              ? (groupPatch.usernames ?? usernames)
              : usernames;
        }
        return { ...storage, groups };
      }),
    );

  const reportSession: AccountsShape["reportSession"] = (
    gameWindowId,
    report,
  ) =>
    changeSession(() => sessions.applyReport(gameWindowId, report)).pipe(
      Effect.flatMap((result) => {
        if (result === null) return Effect.void;
        return result.windowName === undefined
          ? Effect.void
          : gameWindows
              .setName(gameWindowId, result.windowName)
              .pipe(Effect.catch(() => Effect.void));
      }),
    );

  return Accounts.of({
    closeGameWindows,
    createAccount,
    createGroup,
    deleteAccounts,
    deleteGroup,
    focusGameWindow,
    getGameLaunch,
    getRecentlyClosed,
    getState,
    launch,
    onChanged,
    reportSession,
    reopenGameWindow,
    suppressGameWindowLaunchScript,
    updateAccount,
    updateGroup,
  });
});

export const layer = Layer.effect(Accounts, makeAccounts);
