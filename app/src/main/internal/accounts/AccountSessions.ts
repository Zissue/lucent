import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  AccountGameLaunchPayload,
  AccountGameSession,
  AccountScriptReference,
  AccountSessionReport,
  AccountSessionRuntime,
  ManagedAccount,
  RecentlyClosedGameSession,
} from "@lucent/core/accounts";

export interface PendingAccountLaunch {
  readonly account: ManagedAccount;
  readonly requestedAt: number;
  readonly script?: AccountScriptReference;
  readonly server?: string;
}

interface TrackedSession {
  readonly launchPayload?: AccountGameLaunchPayload;
  /** Last accepted report revision for the current renderer generation. */
  readonly rendererRevision: number;
  readonly snapshot: AccountGameSession;
}

export interface AccountSessionReportResult {
  /** The replacement game-view name, when the accepted identity changed. */
  readonly windowName?: string;
}

const scriptName = (
  script: AccountScriptReference | null | undefined,
): string | undefined => {
  const name = script?.name?.trim();
  if (name !== undefined && name !== "") return name;
  const path = script?.path?.trim();
  return path === undefined || path === "" ? undefined : path;
};

const idleRuntime = (launchScriptName?: string): AccountSessionRuntime => ({
  connection: { state: "offline" },
  login: { state: "idle" },
  script:
    launchScriptName === undefined
      ? { state: "idle" }
      : { name: launchScriptName, state: "idle" },
});

const connectionUsername = (
  runtime: AccountSessionRuntime,
): string | undefined =>
  runtime.connection.state === "online"
    ? runtime.connection.username
    : undefined;

const lastConnectionUsername = (
  runtime: AccountSessionRuntime,
): string | undefined =>
  runtime.connection.state === "online"
    ? runtime.connection.username
    : runtime.connection.lastUsername;

export interface AccountSessionsShape {
  readonly revision: number;
  readonly closeWindow: (gameWindowId: number, closedAt: number) => boolean;
  readonly recentlyClosed: (
    gameWindowGroupId: number,
  ) => readonly RecentlyClosedGameSession[];
  readonly forgetClosed: (id: number) => void;
  readonly applyReport: (
    gameWindowId: number,
    report: AccountSessionReport,
  ) => AccountSessionReportResult | null;
  readonly getLaunch: (gameWindowId: number) => AccountGameLaunchPayload | null;
  readonly openWindow: (
    gameWindowId: number,
    gameWindowGroupId: number | undefined,
    rendererGeneration: number,
  ) => boolean;
  readonly reloadWindow: (
    gameWindowId: number,
    gameWindowGroupId: number | undefined,
    rendererGeneration: number,
  ) => boolean;
  readonly remove: (gameWindowId: number) => boolean;
  readonly snapshot: () => readonly AccountGameSession[];
  readonly suppressLaunchScript: (
    gameWindowId: number,
    message: string,
  ) => boolean;
  readonly trackLaunch: (
    gameWindowId: number,
    gameWindowGroupId: number | undefined,
    rendererGeneration: number,
    pending: PendingAccountLaunch,
  ) => void;
}

export class AccountSessions extends Context.Service<
  AccountSessions,
  AccountSessionsShape
>()("lucent/internal/accounts/AccountSessions") {}

export const layer = Layer.effect(
  AccountSessions,
  Effect.sync(() => {
    const sessions = new Map<number, TrackedSession>();
    let revision = 0;
    const closedByGroup = new Map<
      number,
      readonly RecentlyClosedGameSession[]
    >();

    const closeWindow: AccountSessionsShape["closeWindow"] = (
      gameWindowId,
      closedAt,
    ) => {
      const session = sessions.get(gameWindowId);
      if (session === undefined) return false;
      const { snapshot } = session;
      const groupId = snapshot.gameWindowGroupId;
      const username =
        lastConnectionUsername(snapshot) ?? snapshot.launch?.username;
      if (groupId === undefined || username === undefined)
        return remove(gameWindowId);
      const server =
        snapshot.launch?.username.toLowerCase() === username.toLowerCase()
          ? snapshot.launch?.server
          : undefined;
      const entry: RecentlyClosedGameSession = {
        id: gameWindowId,
        closedAt,
        username,
        ...(server === undefined ? {} : { server }),
      };
      const previous = closedByGroup.get(groupId) ?? [];
      closedByGroup.set(
        groupId,
        [
          entry,
          ...previous.filter(
            (candidate) =>
              candidate.username.toLowerCase() !== username.toLowerCase(),
          ),
        ].slice(0, 5),
      );
      return remove(gameWindowId);
    };

    const recentlyClosed: AccountSessionsShape["recentlyClosed"] = (groupId) =>
      closedByGroup.get(groupId) ?? [];
    const forgetClosed: AccountSessionsShape["forgetClosed"] = (id) => {
      for (const [groupId, entries] of closedByGroup) {
        const remaining = entries.filter((entry) => entry.id !== id);
        if (remaining.length === 0) closedByGroup.delete(groupId);
        else if (remaining.length !== entries.length)
          closedByGroup.set(groupId, remaining);
      }
    };

    const getLaunch: AccountSessionsShape["getLaunch"] = (gameWindowId) =>
      sessions.get(gameWindowId)?.launchPayload ?? null;

    const remove: AccountSessionsShape["remove"] = (gameWindowId) => {
      const groupId = sessions.get(gameWindowId)?.snapshot.gameWindowGroupId;
      const removed = sessions.delete(gameWindowId);
      if (removed) revision += 1;
      if (
        groupId !== undefined &&
        ![...sessions.values()].some(
          (session) => session.snapshot.gameWindowGroupId === groupId,
        )
      ) {
        closedByGroup.delete(groupId);
      }
      return removed;
    };

    const snapshot: AccountSessionsShape["snapshot"] = () =>
      [...sessions.values()]
        .map((session) => session.snapshot)
        .toSorted(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            right.gameWindowId - left.gameWindowId,
        );

    const suppressLaunchScript: AccountSessionsShape["suppressLaunchScript"] = (
      gameWindowId,
      message,
    ) => {
      const previous = sessions.get(gameWindowId);
      if (previous === undefined) return false;

      const launchPayload = previous.launchPayload;
      const nextLaunchPayload =
        launchPayload === undefined
          ? undefined
          : {
              account: launchPayload.account,
              gameWindowId: launchPayload.gameWindowId,
              requestedAt: launchPayload.requestedAt,
              ...(launchPayload.server === undefined
                ? {}
                : { server: launchPayload.server }),
            };
      const launch = previous.snapshot.launch;
      const nextLaunch =
        launch === undefined
          ? undefined
          : {
              requestedAt: launch.requestedAt,
              ...(launch.server === undefined ? {} : { server: launch.server }),
              username: launch.username,
            };
      const name = previous.snapshot.script.name ?? launch?.scriptName;

      sessions.set(gameWindowId, {
        ...(nextLaunchPayload === undefined
          ? {}
          : { launchPayload: nextLaunchPayload }),
        rendererRevision: previous.rendererRevision,
        snapshot: {
          ...previous.snapshot,
          ...(nextLaunch === undefined ? {} : { launch: nextLaunch }),
          revision: previous.snapshot.revision + 1,
          script: {
            ...(name === undefined ? {} : { name }),
            message,
            state: "failed",
          },
          updatedAt: Date.now(),
        },
      });
      revision += 1;
      return true;
    };

    const reloadWindow: AccountSessionsShape["reloadWindow"] = (
      gameWindowId,
      gameWindowGroupId,
      rendererGeneration,
    ) => {
      const previous = sessions.get(gameWindowId);
      if (
        previous === undefined ||
        rendererGeneration <= previous.snapshot.rendererGeneration
      ) {
        return false;
      }

      const launchScriptName = previous.snapshot.launch?.scriptName;
      const runtime = idleRuntime(launchScriptName);
      const lastUsername = lastConnectionUsername(previous.snapshot);
      sessions.set(gameWindowId, {
        ...(previous.launchPayload === undefined
          ? {}
          : { launchPayload: previous.launchPayload }),
        rendererRevision: 0,
        snapshot: {
          ...previous.snapshot,
          ...(gameWindowGroupId === undefined ? {} : { gameWindowGroupId }),
          rendererGeneration,
          revision: previous.snapshot.revision + 1,
          ...runtime,
          connection:
            lastUsername === undefined
              ? runtime.connection
              : { lastUsername, state: "offline" },
          login:
            previous.launchPayload === undefined
              ? runtime.login
              : { state: "waiting-for-game" },
          updatedAt: Date.now(),
        },
      });
      revision += 1;
      return true;
    };

    const openWindow: AccountSessionsShape["openWindow"] = (
      gameWindowId,
      gameWindowGroupId,
      rendererGeneration,
    ) => {
      const previous = sessions.get(gameWindowId);
      if (previous !== undefined) {
        if (rendererGeneration > previous.snapshot.rendererGeneration) {
          return reloadWindow(
            gameWindowId,
            gameWindowGroupId,
            rendererGeneration,
          );
        }
        return false;
      }

      sessions.set(gameWindowId, {
        rendererRevision: 0,
        snapshot: {
          gameWindowId,
          ...(gameWindowGroupId === undefined ? {} : { gameWindowGroupId }),
          rendererGeneration,
          revision: 1,
          ...idleRuntime(),
          updatedAt: Date.now(),
        },
      });
      revision += 1;
      return true;
    };

    const trackLaunch: AccountSessionsShape["trackLaunch"] = (
      gameWindowId,
      gameWindowGroupId,
      rendererGeneration,
      pending,
    ) => {
      openWindow(gameWindowId, gameWindowGroupId, rendererGeneration);
      const previous = sessions.get(gameWindowId);
      if (
        previous === undefined ||
        rendererGeneration !== previous.snapshot.rendererGeneration
      ) {
        return;
      }

      const payload: AccountGameLaunchPayload = {
        account: pending.account,
        ...(pending.script === undefined ? {} : { script: pending.script }),
        ...(pending.server === undefined ? {} : { server: pending.server }),
        gameWindowId,
        requestedAt: pending.requestedAt,
      };
      const launchScriptName = scriptName(payload.script);
      sessions.set(gameWindowId, {
        launchPayload: payload,
        rendererRevision: previous.rendererRevision,
        snapshot: {
          ...previous.snapshot,
          ...(gameWindowGroupId === undefined ? {} : { gameWindowGroupId }),
          launch: {
            requestedAt: payload.requestedAt,
            ...(launchScriptName === undefined
              ? {}
              : { scriptName: launchScriptName }),
            ...(payload.server === undefined ? {} : { server: payload.server }),
            username: payload.account.username,
          },
          login: { state: "waiting-for-game" },
          rendererGeneration,
          revision: previous.snapshot.revision + 1,
          script:
            launchScriptName === undefined
              ? { state: "idle" }
              : { name: launchScriptName, state: "idle" },
          updatedAt: Date.now(),
        },
      });
      revision += 1;
    };

    const applyReport: AccountSessionsShape["applyReport"] = (
      gameWindowId,
      report,
    ) => {
      const previous = sessions.get(gameWindowId);
      // A renderer may report only for a window generation observed by main.
      if (
        previous === undefined ||
        report.rendererGeneration !== previous.snapshot.rendererGeneration ||
        report.revision <= previous.rendererRevision
      ) {
        return null;
      }

      if (
        report.runtime.connection.state === "online" &&
        report.runtime.connection.username.trim() === ""
      ) {
        return null;
      }

      const previousUsername = connectionUsername(previous.snapshot);
      const nextUsername = connectionUsername(report.runtime);
      const nextSnapshot: AccountGameSession = {
        ...previous.snapshot,
        ...report.runtime,
        revision: previous.snapshot.revision + 1,
        updatedAt: Date.now(),
      };
      sessions.set(gameWindowId, {
        ...(previous.launchPayload === undefined
          ? {}
          : { launchPayload: previous.launchPayload }),
        rendererRevision: report.revision,
        snapshot: nextSnapshot,
      });
      revision += 1;

      return previousUsername === nextUsername
        ? {}
        : { windowName: nextUsername ?? "" };
    };

    return AccountSessions.of({
      get revision() {
        return revision;
      },
      closeWindow,
      recentlyClosed,
      forgetClosed,
      applyReport,
      getLaunch,
      openWindow,
      reloadWindow,
      remove,
      snapshot,
      suppressLaunchScript,
      trackLaunch,
    });
  }),
);
