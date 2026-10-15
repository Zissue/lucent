import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  resolveArmyEquipSet,
  resolveArmyItemAlias,
  type ArmyConfigRaw,
  type ArmyEquipSet,
  type ArmyProgressResult,
  type ArmySessionPayload,
} from "@lucent/core/army";
import {
  selectDesktopBridge,
  type DesktopArmyBridge,
} from "../../../../shared/desktopBridge";
import { Api, type ApiService } from "../flash/api/Api";
import { isDirectInventoryConsumable } from "../flash/api/Inventory";
import type { ScriptArmyApi } from "../scripting/ScriptApi";
import {
  ArmyLoopTauntError,
  type ArmyLoopTauntHandle,
  type ArmyLoopTauntRuntimePlan,
  makeArmyLoopTauntRuntime,
} from "./ArmyLoopTaunt";

export class ArmyError extends Error {
  readonly _tag = "ArmyError";

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ArmyError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
  }
}

export interface ArmyRunStepOptions {
  readonly timeout?: Duration.Input;
}

export interface ArmyEquipSetOptions {
  readonly resolveItems?: boolean;
}

export type ArmySession = ArmySessionPayload;

export interface ArmyApiRuntimeShape extends Omit<ScriptArmyApi, "loopTaunt"> {
  readonly loopTaunt: (
    plan: ArmyLoopTauntRuntimePlan,
    onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>,
  ) => Effect.Effect<ArmyLoopTauntHandle, ArmyLoopTauntError>;
}

export class ArmyApi extends Context.Service<ArmyApi, ArmyApiRuntimeShape>()(
  "lucent/game/army/ArmyApi",
) {}

type ArmyState =
  | { readonly type: "Idle" }
  | {
      readonly type: "Starting";
      readonly endedSessions: ReadonlyMap<string, ArmyError>;
    }
  | {
      readonly type: "Started";
      readonly ended: Deferred.Deferred<never, ArmyError>;
      readonly nextStep: number;
      readonly session: ArmySession;
    };

interface RosterStatus {
  readonly complete: boolean;
  readonly label: string;
}

type StartedState = Extract<ArmyState, { readonly type: "Started" }>;

const idle: ArmyState = { type: "Idle" };

const joinRosterTimeoutMs = 30_000;
const progressPollInterval = "250 millis";
const consumableSkillIndex = 5;

const cloneSession = (session: ArmySession): ArmySession =>
  structuredClone(session);

const optionTimeoutMs = (
  options: ArmyRunStepOptions | undefined,
): number | undefined =>
  options?.timeout === undefined
    ? undefined
    : Duration.toMillis(options.timeout);

const fromDesktop = <A>(fallback: string, promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) =>
      new ArmyError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : fallback,
        cause,
      ),
  });

const normalizePlayerKey = (name: string): string => name.trim().toLowerCase();

const withArmyRoom = (map: string, room: string): string => {
  const target = map.trim();
  if (target === "" || /-\d+$/.test(target)) {
    return target;
  }
  return `${target}-${room.trim()}`;
};

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.length > 0
    ? squashed.message
    : Cause.pretty(cause);
};

const resolveSetItem = (
  session: ArmySession,
  item: string | undefined,
  resolveItems: boolean,
): string | undefined =>
  resolveItems ? resolveArmyItemAlias(session, item) : item;

const warnEquip = (
  setName: string,
  field: string,
  item: string,
  cause?: Cause.Cause<unknown>,
) =>
  Effect.logWarning(
    "Army equipSet skipped item",
    ...(cause === undefined ? [] : [cause]),
  ).pipe(
    Effect.annotateLogs({ component: "army", data: { field, item, setName } }),
  );

const getNestedConfigValue = (
  obj: Record<string, unknown>,
  path: string,
  defaultValue: unknown,
): unknown => {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    const key = part.trim();
    if (key === "") {
      return defaultValue;
    }

    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !(key in current)
    ) {
      return defaultValue;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

const resolveConfigValue = (
  raw: ArmyConfigRaw,
  key: string,
  defaultValue: unknown,
): unknown => {
  const normalized = key.trim();
  if (normalized === "") {
    return raw;
  }

  const value = normalized.includes(".")
    ? getNestedConfigValue(raw, normalized, defaultValue)
    : raw[normalized];

  return value === undefined ? defaultValue : value;
};

const armyEquipOrder = [
  "safeClass",
  "safePot",
  "class",
  "safePot",
  "weapon",
  "cape",
  "helm",
  "armor",
  "pet",
] as const satisfies readonly (keyof ArmyEquipSet)[];

const makeArmyApi = (
  api: ApiService,
  bridge: DesktopArmyBridge = selectDesktopBridge(window.desktop, "game").army,
) =>
  Effect.gen(function* () {
    const {
      auth,
      combat,
      drops,
      inventory,
      map,
      player,
      players,
      tempInventory,
      wait,
    } = api;
    const stateRef = yield* Ref.make<ArmyState>(idle);
    const operationLock = yield* Semaphore.make(1);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const currentSession = Ref.get(stateRef).pipe(
      Effect.map((state) => (state.type === "Started" ? state.session : null)),
    );

    const getSession: ScriptArmyApi["getSession"] = () =>
      currentSession.pipe(
        Effect.map((session) =>
          session === null ? null : cloneSession(session),
        ),
      );
    const loopTaunts = yield* makeArmyLoopTauntRuntime(api, bridge, getSession);

    const assertStarted = currentSession.pipe(
      Effect.flatMap((session) =>
        session === null
          ? Effect.fail(new ArmyError("Army has not been started"))
          : Effect.succeed(cloneSession(session)),
      ),
    );

    const endLocally = (sessionId: string, error: ArmyError) =>
      Ref.modify(stateRef, (state): readonly [StartedState | null, ArmyState] =>
        state.type === "Starting"
          ? [
              null,
              {
                type: "Starting",
                endedSessions: new Map(state.endedSessions).set(
                  sessionId,
                  error,
                ),
              },
            ]
          : state.type === "Started" && state.session.sessionId === sessionId
            ? [state, idle]
            : [null, state],
      ).pipe(
        Effect.flatMap((ended) =>
          ended === null
            ? Effect.succeed(false)
            : Deferred.fail(ended.ended, error).pipe(Effect.as(true)),
        ),
        Effect.uninterruptible,
      );

    const failSession = (sessionId: string, reason: string) =>
      endLocally(sessionId, new ArmyError(reason)).pipe(
        Effect.flatMap((ended) =>
          ended
            ? Effect.sync(() => {
                void bridge.fail({ reason, sessionId }).catch(() => undefined);
              }).pipe(Effect.ignoreCause)
            : Effect.void,
        ),
      );

    const exclusive = <A, E>(
      operation: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ArmyError> =>
      operationLock
        .withPermitsIfAvailable(1)(operation)
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ArmyError(
                    "Another coordinated army operation is already running",
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

    const coordinated = <A, E>(
      steps: number,
      body: (session: ArmySession, step: number) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ArmyError> =>
      exclusive(
        Effect.gen(function* () {
          const reserved = yield* Ref.modify(
            stateRef,
            (state): readonly [StartedState | null, ArmyState] =>
              state.type === "Started"
                ? [state, { ...state, nextStep: state.nextStep + steps }]
                : [null, state],
          );
          if (reserved === null) {
            return yield* Effect.fail(
              new ArmyError("Army has not been started"),
            );
          }
          const { ended, nextStep, session } = reserved;
          return yield* Effect.raceFirst(
            body(session, nextStep),
            Deferred.await(ended),
          ).pipe(
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : failSession(session.sessionId, causeMessage(cause)),
            ),
          );
        }),
      );

    const loopTaunt: ArmyApiRuntimeShape["loopTaunt"] = (plan, onFailure) =>
      exclusive(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const startup = loopTaunts.loopTaunt(plan, onFailure);
          return yield* state.type === "Started"
            ? Effect.raceFirst(startup, Deferred.await(state.ended))
            : startup;
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof ArmyLoopTauntError
            ? error
            : new ArmyLoopTauntError(
                "Failed to coordinate Loop Taunt startup",
                error,
              ),
        ),
      );

    const waitAtSync = (
      session: ArmySession,
      step: number,
      label: string,
      options?: ArmyRunStepOptions,
    ) =>
      fromDesktop("Failed to synchronize army", () => {
        const timeoutMs = optionTimeoutMs(options);
        return bridge.sync({
          label,
          sessionId: session.sessionId,
          step,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      });

    const reportProgress = (
      session: ArmySession,
      step: number,
      label: string,
      complete: boolean,
      options?: ArmyRunStepOptions,
    ): Effect.Effect<ArmyProgressResult, ArmyError> =>
      fromDesktop("Failed to synchronize army progress", () => {
        const timeoutMs = optionTimeoutMs(options);
        return bridge.progress({
          complete,
          label,
          sessionId: session.sessionId,
          step,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      });

    const awaitRosterReport = <E>(
      report: (
        status: RosterStatus,
      ) => Effect.Effect<ArmyProgressResult, ArmyError>,
      observe: Effect.Effect<RosterStatus, E>,
    ): Effect.Effect<ArmyProgressResult, E | ArmyError> =>
      Effect.gen(function* () {
        const reported = yield* observe;
        const completed = yield* Deferred.make<ArmyProgressResult, ArmyError>();
        const changes = Effect.gen(function* () {
          let previous = reported;
          while (true) {
            yield* Effect.sleep(progressPollInterval);
            const next = yield* observe;
            if (
              next.complete === previous.complete &&
              next.label === previous.label
            ) {
              continue;
            }
            previous = next;
            yield* Deferred.complete(completed, report(next)).pipe(
              Effect.forkChild,
            );
          }
        });
        return yield* Effect.raceFirst(
          Effect.raceFirst(report(reported), Deferred.await(completed)),
          changes,
        );
      });

    const runStep: ScriptArmyApi["runStep"] = (label, action, options) =>
      coordinated(1, (session, step) =>
        action.pipe(
          Effect.tap(() => waitAtSync(session, step, label, options)),
        ),
      );

    const sync: ScriptArmyApi["sync"] = (label = "sync", options) =>
      coordinated(1, (session, step) =>
        waitAtSync(session, step, label, options),
      );

    const start: ScriptArmyApi["start"] = (configName) =>
      exclusive(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(stateRef)).type === "Started") {
              return yield* Effect.fail(
                new ArmyError(
                  "Army has already been started; leave it before starting again",
                ),
              );
            }
            const username = yield* restore(auth.getUsername());
            yield* Ref.set(stateRef, {
              type: "Starting",
              endedSessions: new Map(),
            });
            const session = yield* restore(
              fromDesktop("Failed to start army", () =>
                bridge.start({ configName, playerName: username }),
              ),
            ).pipe(
              Effect.onInterrupt(() =>
                fromDesktop("Failed to leave army", () => bridge.leave()).pipe(
                  Effect.ignore,
                ),
              ),
            );
            const state = yield* Ref.get(stateRef);
            if (state.type === "Starting") {
              const reason = state.endedSessions.get(session.sessionId);
              if (reason !== undefined) return yield* Effect.fail(reason);
            }
            const ended = yield* Deferred.make<never, ArmyError>();
            yield* Ref.set(stateRef, {
              type: "Started",
              ended,
              nextStep: 0,
              session,
            });
            return cloneSession(session);
          }).pipe(
            Effect.ensuring(
              Ref.update(stateRef, (state) =>
                state.type === "Starting" ? idle : state,
              ),
            ),
          ),
        ),
      );

    const leave: ScriptArmyApi["leave"] = () =>
      Effect.gen(function* () {
        yield* loopTaunts.stopActive("Army session is leaving");
        const state = yield* Ref.get(stateRef);
        yield* fromDesktop("Failed to leave army", () => bridge.leave()).pipe(
          Effect.ignore,
        );
        if (state.type === "Started") {
          yield* endLocally(
            state.session.sessionId,
            new ArmyError("Army session left"),
          );
        }
      });

    const isStarted: ScriptArmyApi["isStarted"] = () =>
      currentSession.pipe(Effect.map((session) => session !== null));

    const isLeader: ScriptArmyApi["isLeader"] = () =>
      currentSession.pipe(Effect.map((session) => session?.role === "leader"));

    const isMember: ScriptArmyApi["isMember"] = () =>
      currentSession.pipe(Effect.map((session) => session?.role === "member"));

    const getPlayerNumber: ScriptArmyApi["getPlayerNumber"] = () =>
      currentSession.pipe(
        Effect.map((session) => session?.playerNumber ?? null),
      );

    const getConfigValue: ScriptArmyApi["getConfigValue"] = (
      key,
      defaultValue,
    ) =>
      currentSession.pipe(
        Effect.map((session) =>
          session === null
            ? defaultValue
            : resolveConfigValue(session.raw, key, defaultValue),
        ),
      );

    const getConfigString: ScriptArmyApi["getConfigString"] = (
      key,
      defaultValue = "",
    ) =>
      getConfigValue(key, defaultValue).pipe(
        Effect.map((value) =>
          typeof value === "string" ? value : defaultValue,
        ),
      );

    const visibleMissingPlayers = (session: ArmySession) =>
      Effect.gen(function* () {
        const visible = new Set(
          (yield* players.getAll()).map((record) =>
            normalizePlayerKey(record.username),
          ),
        );
        return session.players.filter(
          (armyPlayer) => !visible.has(normalizePlayerKey(armyPlayer)),
        );
      });

    const awaitRosterInMap = (session: ArmySession, step: number) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + joinRosterTimeoutMs;
        const observe = Effect.gen(function* () {
          const [mapName, roomNumber, missing] = yield* Effect.all([
            map.getName(),
            map.getRoomNumber(),
            visibleMissingPlayers(session),
          ]);
          return {
            complete: missing.length === 0,
            label: `map:${mapName.trim().toLowerCase()}-${roomNumber}`,
          };
        });
        const report = (status: RosterStatus) =>
          reportProgress(session, step, status.label, status.complete, {
            timeout: joinRosterTimeoutMs,
          });
        const firstRound = yield* awaitRosterReport(report, observe);
        if (firstRound.complete) {
          return;
        }
        const remainingMs = deadline - (yield* Clock.currentTimeMillis);
        const completed = yield* awaitRosterReport(report, observe).pipe(
          Effect.timeoutOption(Math.max(0, remainingMs)),
        );
        if (Option.isSome(completed)) {
          return;
        }

        const missing = yield* visibleMissingPlayers(session);
        const { label } = yield* observe;
        return yield* Effect.fail(
          new ArmyError(
            missing.length > 0
              ? `Timed out waiting for army roster in ${label}; ${
                  session.playerName
                } cannot see: ${missing.join(", ")}`
              : `Timed out waiting for army roster in ${label}; pending players: ${firstRound.pendingPlayers.join(
                  ", ",
                )}`,
          ),
        );
      });

    const waitForAllInMap: ScriptArmyApi["waitForAllInMap"] = () =>
      coordinated(1, awaitRosterInMap);

    const joinMap: ScriptArmyApi["joinMap"] = (map, options) =>
      coordinated(2, (session, step) =>
        Effect.gen(function* () {
          const resolvedMap = withArmyRoom(map, session.room);
          yield* waitAtSync(session, step, `join-ready:${resolvedMap}`);
          if (!(yield* player.joinMap(resolvedMap, options))) {
            return yield* Effect.fail(
              new ArmyError(`Failed to join army map: ${resolvedMap}`),
            );
          }
          yield* awaitRosterInMap(session, step + 1);
        }),
      );

    const kill: ScriptArmyApi["kill"] = (target, options) =>
      runStep(
        `kill:${String(target)}`,
        combat.kill(target, options).pipe(Effect.asVoid),
      );

    const killUntilRosterComplete = <E>(args: {
      readonly action: Effect.Effect<void, E>;
      readonly isComplete: Effect.Effect<boolean, E>;
      readonly label: string;
    }): Effect.Effect<void, E | ArmyError> =>
      coordinated(1, (session, step) =>
        Effect.gen(function* () {
          const report = (status: RosterStatus) =>
            reportProgress(session, step, status.label, status.complete);
          const observe = args.isComplete.pipe(
            Effect.map((complete) => ({ complete, label: args.label })),
          );
          if ((yield* awaitRosterReport(report, observe)).complete) {
            return;
          }
          yield* Effect.raceFirst(
            awaitRosterReport(report, observe),
            Effect.forever(
              args.action.pipe(Effect.andThen(Effect.sleep("100 millis"))),
            ),
          );
        }),
      );

    const killForItem: ScriptArmyApi["killForItem"] = (target, goal, options) =>
      killUntilRosterComplete({
        action: combat.kill(target, options).pipe(Effect.asVoid),
        isComplete: Effect.gen(function* () {
          if (yield* drops.contains(goal.item)) {
            yield* drops.accept(goal.item);
          }
          return yield* inventory.contains(goal.item, goal.quantity);
        }),
        label: `kill-item:${String(goal.item)}`,
      });

    const killForTempItem: ScriptArmyApi["killForTempItem"] = (
      target,
      goal,
      options,
    ) =>
      killUntilRosterComplete({
        action: combat.kill(target, options).pipe(Effect.asVoid),
        isComplete: tempInventory.contains(goal.item, goal.quantity),
        label: `kill-temp:${String(goal.item)}`,
      });

    const equipItem = (
      session: ArmySession,
      setName: string,
      field: string,
      item: string | undefined,
      resolveItems: boolean,
    ) =>
      Effect.gen(function* () {
        const resolved = resolveSetItem(session, item, resolveItems);
        if (resolved === undefined) {
          return;
        }

        const equipped = yield* inventory.equip(resolved).pipe(
          Effect.tap((equipped) =>
            equipped ? Effect.void : warnEquip(setName, field, resolved),
          ),
          Effect.catchCause((cause) =>
            warnEquip(setName, field, resolved, cause).pipe(Effect.as(false)),
          ),
        );
        if (!equipped) {
          return;
        }

        yield* Effect.sleep("500 millis");
      });

    const drinkConsumable = Effect.fn("Army.drinkConsumable")(function* (
      session: ArmySession,
      setName: string,
      item: string,
      resolveItems: boolean,
    ) {
      const resolved = resolveSetItem(session, item, resolveItems);
      if (resolved === undefined) {
        return;
      }

      const inventoryItem = yield* inventory.get(resolved).pipe(
        Effect.tap((item) =>
          item === null ? warnEquip(setName, "pots", resolved) : Effect.void,
        ),
        Effect.catchCause((cause) =>
          warnEquip(setName, "pots", resolved, cause).pipe(Effect.as(null)),
        ),
      );
      if (inventoryItem === null) {
        return;
      }

      if (isDirectInventoryConsumable(inventoryItem.link)) {
        const used = yield* inventory.use(inventoryItem.itemId).pipe(
          Effect.tap((used) =>
            used ? Effect.void : warnEquip(setName, "pots", resolved),
          ),
          Effect.catchCause((cause) =>
            warnEquip(setName, "pots", resolved, cause).pipe(Effect.as(false)),
          ),
        );
        if (!used) {
          return;
        }

        yield* Effect.sleep("1 second");
        return;
      }

      const startingQuantity = inventoryItem.quantity;

      const equipped = yield* inventory.equip(resolved).pipe(
        Effect.tap((succeeded) =>
          succeeded ? Effect.void : warnEquip(setName, "pots", resolved),
        ),
        Effect.catchCause((cause) =>
          warnEquip(setName, "pots", resolved, cause).pipe(Effect.as(false)),
        ),
      );
      if (!equipped) {
        return;
      }

      const slotReady = yield* wait.until(
        combat.getConsumableSkillItem().pipe(
          Effect.map(
            (slot) =>
              slot?.itemId === inventoryItem.itemId && slot.ready === true,
          ),
          Effect.catchCause(() => Effect.succeed(false)),
        ),
        { timeout: "5 seconds" },
      );
      if (!slotReady) {
        yield* warnEquip(setName, "pots", resolved);
        return;
      }

      const used = yield* combat
        .useSkill(consumableSkillIndex, {
          force: true,
          waitUntilReady: true,
        })
        .pipe(
          Effect.tap((succeeded) =>
            succeeded ? Effect.void : warnEquip(setName, "pots", resolved),
          ),
          Effect.catchCause((cause) =>
            warnEquip(setName, "pots", resolved, cause).pipe(Effect.as(false)),
          ),
        );
      if (!used) {
        return;
      }

      const consumed = yield* wait.until(
        inventory.get(inventoryItem.itemId).pipe(
          Effect.map(
            (current) =>
              current === null || current.quantity < startingQuantity,
          ),
          Effect.catchCause(() => Effect.succeed(false)),
        ),
        { timeout: "5 seconds" },
      );
      if (!consumed) {
        yield* warnEquip(setName, "pots", resolved);
        return;
      }

      yield* Effect.sleep("1 second");
    });

    const equipSet: ScriptArmyApi["equipSet"] = (setName, options) =>
      runStep(
        `equip:${setName}`,
        Effect.gen(function* () {
          const session = yield* assertStarted;
          const set = resolveArmyEquipSet(session, setName);
          if (set === undefined) {
            return;
          }

          const resolveItems = options?.resolveItems === true;
          for (const field of armyEquipOrder) {
            const item = set[field];
            if (typeof item === "string") {
              yield* equipItem(session, setName, field, item, resolveItems);
            }
          }

          for (const pot of set.pots ?? []) {
            yield* drinkConsumable(session, setName, pot, resolveItems);
          }

          yield* equipItem(
            session,
            setName,
            "scroll",
            set.scroll,
            resolveItems,
          );
        }),
      );

    const disposeEnded = bridge.onEnded((payload) => {
      runFork(
        endLocally(payload.sessionId, new ArmyError(payload.reason)).pipe(
          Effect.andThen(loopTaunts.notifySessionEnded(payload)),
        ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(disposeEnded));

    return ArmyApi.of({
      equipSet,
      getConfigString,
      getConfigValue,
      getPlayerNumber,
      getSession,
      isLeader,
      isMember,
      isStarted,
      joinMap,
      kill,
      killForItem,
      killForTempItem,
      leave,
      loopTaunt,
      runStep,
      start,
      sync,
      waitForAllInMap,
    });
  });

export const layer = Layer.effect(
  ArmyApi,
  Effect.flatMap(Api, (api) => makeArmyApi(api)),
);

export { ArmyLoopTauntError } from "./ArmyLoopTaunt";
export type {
  ArmyLoopTauntAssignment,
  ArmyLoopTauntHandle,
  ArmyLoopTauntPlan,
  ArmyLoopTauntPriorityGroup,
  ArmyLoopTauntStrategy,
} from "./ArmyLoopTaunt";
