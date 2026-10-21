import { app, session, type Session } from "electron";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import {
  allowArtixCors,
  handleRuffleAssets,
  RUFFLE_ASSET_SCHEME,
} from "./RuffleAssets";
import {
  applyLauncherHeaders,
  getGameRequestHeaders,
  getGameUserAgent,
} from "./GameRequestHeaders";
import {
  activateManagedGamePartitionProfile,
  cleanupStaleGamePartitionProfiles,
  type GamePartitionOwner,
  makeGamePartitionRegistry,
  managedGamePartition,
  listPersistentGamePartitions,
  retireManagedGamePartitionProfile,
} from "./GamePartitions";

export class ElectronGamePartitionError extends Schema.TaggedError<ElectronGamePartitionError>()(
  "ElectronGamePartitionError",
  {
    cause: Schema.Defect(),
    partition: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to prepare isolated game partition: ${this.partition}.`;
  }
}

export class ElectronSessionDataClearError extends Schema.TaggedError<ElectronSessionDataClearError>()(
  "ElectronSessionDataClearError",
  { cause: Schema.Defect() },
) {}

export const clearSessionData = (
  sessions: Iterable<Pick<Session, "clearData">>,
) =>
  Effect.validate(
    new Set(sessions),
    (target) =>
      Effect.tryPromise({
        try: () => target.clearData(),
        catch: (cause) => cause,
      }),
    { concurrency: 4, discard: true },
  ).pipe(
    Effect.mapError((cause) => new ElectronSessionDataClearError({ cause })),
  );

export interface GameSessionsShape {
  readonly clearAppData: Effect.Effect<void, ElectronSessionDataClearError>;
  readonly acquireGamePartition: (
    owner: GamePartitionOwner,
  ) => Effect.Effect<string, ElectronGamePartitionError, Scope.Scope>;
  readonly prepareGameNetworking: Effect.Effect<void>;
  readonly retireManagedGameProfile: (
    key: string,
  ) => Effect.Effect<void, ElectronGamePartitionError>;
}

export class GameSessions extends Context.Service<
  GameSessions,
  GameSessionsShape
>()("lucent/desktop/game/session/GameSessions") {}

export const layer = Layer.effect(
  GameSessions,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const gameRequestHeaders = getGameRequestHeaders(env.platform);
    const gameUserAgent = getGameUserAgent(env.platform);
    const configuredSessions = new Set<Session>();
    const gameSessions = new Map<string, Session>();
    const runCleanup = yield* FiberSet.makeRuntime<never, void>();
    const gamePartitions = makeGamePartitionRegistry();
    const partitionOperations = yield* Semaphore.make(1);
    let sessionCreatedHookInstalled = false;

    yield* Effect.gen(function* () {
      const sessionDataDir = yield* Effect.sync(() =>
        app.getPath("sessionData"),
      );
      yield* cleanupStaleGamePartitionProfiles(sessionDataDir, fileSystem);
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.uninterruptible,
    );

    const configureSession = (targetSession: Session): void => {
      if (configuredSessions.has(targetSession)) {
        return;
      }

      configuredSessions.add(targetSession);
      targetSession.setUserAgent(gameUserAgent);
      targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        for (const [name, value] of Object.entries(gameRequestHeaders)) {
          requestHeaders[name] = value;
        }
        applyLauncherHeaders(requestHeaders, details.method, details.url);

        callback({ cancel: false, requestHeaders });
      });
      handleRuffleAssets(targetSession, env.assetsDir);
      allowArtixCors(targetSession);
    };

    const prepareGameNetworking = Effect.sync(() => {
      configureSession(session.defaultSession);
      if (sessionCreatedHookInstalled) {
        return;
      }

      sessionCreatedHookInstalled = true;
      app.on("session-created", configureSession);
    });

    const acquireGamePartition: GameSessionsShape["acquireGamePartition"] =
      Effect.fn("GameSessions.acquireGamePartition")(function* (owner) {
        const partition = yield* Effect.acquireRelease(
          Effect.sync(() => gamePartitions.acquire(owner)),
          (partition) => Effect.sync(() => releaseGamePartition(partition)),
        );
        return yield* partitionOperations.withPermit(
          Effect.gen(function* () {
            if (owner.kind === "managed-account") {
              const profilePath = yield* Effect.try({
                try: () =>
                  session.fromPartition(managedGamePartition(owner.key))
                    .storagePath,
                catch: (cause) => cause,
              });
              if (profilePath !== null)
                yield* activateManagedGamePartitionProfile(
                  profilePath,
                  fileSystem,
                );
            }
            return yield* Effect.try({
              try: () => {
                const target = session.fromPartition(partition);
                configureSession(target);
                gameSessions.set(partition, target);
                return partition;
              },
              catch: (cause) => cause,
            });
          }).pipe(
            Effect.mapError(
              (cause) => new ElectronGamePartitionError({ cause, partition }),
            ),
            Effect.uninterruptible,
          ),
        );
      });

    const retireManagedGameProfile: GameSessionsShape["retireManagedGameProfile"] =
      (key) => {
        const partition = managedGamePartition(key);
        return partitionOperations.withPermit(
          Effect.gen(function* () {
            const profilePath = yield* Effect.try({
              try: () => session.fromPartition(partition).storagePath,
              catch: (cause) => cause,
            });
            if (profilePath !== null)
              yield* retireManagedGamePartitionProfile(profilePath, fileSystem);
          }).pipe(
            Effect.mapError(
              (cause) => new ElectronGamePartitionError({ cause, partition }),
            ),
            Effect.uninterruptible,
          ),
        );
      };

    const clearAppData = Effect.gen(function* () {
      const sessionDataDir = yield* Effect.try({
        try: () => app.getPath("sessionData"),
        catch: (cause) => new ElectronSessionDataClearError({ cause }),
      });
      const partitions = yield* listPersistentGamePartitions(
        sessionDataDir,
      ).pipe(
        Effect.mapError(
          (cause) => new ElectronSessionDataClearError({ cause }),
        ),
      );
      const targets = yield* Effect.try({
        try: () =>
          new Set([
            session.defaultSession,
            ...gameSessions.values(),
            ...partitions.map((partition) => session.fromPartition(partition)),
          ]),
        catch: (cause) => new ElectronSessionDataClearError({ cause }),
      });
      yield* clearSessionData(targets);
    });

    const releaseGamePartition = (partition: string): void => {
      gamePartitions.release(partition);
      const target = gameSessions.get(partition);
      if (target === undefined || target.storagePath !== null) return;
      gameSessions.delete(partition);
      runCleanup(
        clearSessionData([target]).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Failed to clear a temporary game session",
              Cause.fail(cause),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              target.webRequest.onBeforeSendHeaders(null);
              target.webRequest.onHeadersReceived(null);
              target.protocol.unhandle(RUFFLE_ASSET_SCHEME);
              configuredSessions.delete(target);
            }),
          ),
        ),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (sessionCreatedHookInstalled) {
          app.removeListener("session-created", configureSession);
          sessionCreatedHookInstalled = false;
        }
        for (const configuredSession of configuredSessions) {
          configuredSession.webRequest.onBeforeSendHeaders(null);
          configuredSession.webRequest.onHeadersReceived(null);
        }
        configuredSessions.clear();
      }),
    );

    return GameSessions.of({
      acquireGamePartition,
      clearAppData,
      prepareGameNetworking,
      retireManagedGameProfile,
    });
  }),
);
