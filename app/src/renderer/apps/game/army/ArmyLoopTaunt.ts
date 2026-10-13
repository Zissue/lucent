import type {
  ArmyLoopTauntCommandPayload,
  ArmyLoopTauntMapIdentity,
  ArmyLoopTauntReport,
  ArmyLoopTauntStrategy,
  ArmySessionEndedPayload,
} from "@lucent/core/army";
import type { MonsterQuery, PlayerSnapshot } from "@lucent/game";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { DesktopArmyBridge } from "../../../../shared/desktopBridge";
import type { ApiService } from "../flash/api/Api";
import {
  CONSUMABLE_CAST_CONFIRMATION_TIMEOUT_MS,
  ConsumableCastDispatchDeadline,
} from "../flash/api/Combat";
import type { Event } from "../flash/contract/Event";

const LOOP_TAUNT_SCROLL_ITEM_ID = 12_917; // Scroll of Enrage
const LOOP_TAUNT_SCROLL_SKILL = 5;
const LOOP_TAUNT_STATUS_INTERVAL_MS = 250;
const LOOP_TAUNT_TARGET_INTERVAL_MS = 500;
const LOOP_TAUNT_SKIP_TIMEOUT_MS = 1_000;
const LOOP_TAUNT_COMMAND_REPORT_MARGIN_MS = 250;
// Reserve Combat's acknowledgement window so a coordinator lease cannot expire
// after the cast has already been dispatched.
const LOOP_TAUNT_CAST_LEASE_MS =
  CONSUMABLE_CAST_CONFIRMATION_TIMEOUT_MS + LOOP_TAUNT_COMMAND_REPORT_MARGIN_MS;
const LOOP_TAUNT_FOCUS_AURA_NAME = "focus";
const LOOP_TAUNT_FOCUS_AURA_ICON = "iwd1,ied1";

export type { ArmyLoopTauntStrategy };

/** Identifies an assigned Army player and its point-in-time projected state. */
export interface ArmyLoopTauntParticipantSnapshot {
  /** One-based position in the active Army roster. */
  readonly playerNumber: number;
  /** Point-in-time player state captured immediately before this attempt. */
  readonly player: PlayerSnapshot;
}

/** Projected state available when deciding whether to yield a taunt attempt. */
export interface ArmyLoopTauntSkipContext {
  /** Snapshots for the players assigned to this target. */
  readonly participants: readonly ArmyLoopTauntParticipantSnapshot[];
  /** The assigned participant selected for this attempt. */
  readonly self: ArmyLoopTauntParticipantSnapshot;
}

/** Returns true when the selected player should yield to the next participant. */
export type ArmyLoopTauntSkipWhen = (
  context: ArmyLoopTauntSkipContext,
) =>
  | boolean
  | Effect.Effect<boolean, unknown>
  | Generator<Effect.Effect<any, any, never>, boolean, any>;

export type ArmyLoopTauntRuntimeSkipWhen = (
  context: ArmyLoopTauntSkipContext,
) => Effect.Effect<boolean, unknown>;

/** Assigns one target to the Army players allowed to keep it taunted. */
export interface ArmyLoopTauntAssignment {
  /** One-based player numbers from the active Army roster. */
  readonly players: readonly number[];
  /** Skips the selected player's attempt when the callback returns true. */
  readonly skipWhen?: ArmyLoopTauntSkipWhen;
  /** The event that starts each taunt attempt. */
  readonly strategy: ArmyLoopTauntStrategy;
  /** The monster this assignment may taunt. */
  readonly target: MonsterQuery;
}

/**
 * A set of target assignments evaluated at the same priority.
 *
 * Living assignments in the selected group run concurrently.
 */
export interface ArmyLoopTauntPriorityGroup {
  /** Target rotations that may run together while this group is selected. */
  readonly assignments: readonly ArmyLoopTauntAssignment[];
}

/**
 * Ordered target priorities shared by every participant in the Army.
 *
 * The first group with a living target is selected. When all of its targets
 * die, the next eligible group takes over; a respawn preempts lower groups and
 * restarts that target's rotation from its first assigned player.
 */
export type ArmyLoopTauntPlan = readonly ArmyLoopTauntPriorityGroup[];

export interface ArmyLoopTauntRuntimeAssignment extends Omit<
  ArmyLoopTauntAssignment,
  "skipWhen"
> {
  readonly skipWhen?: ArmyLoopTauntRuntimeSkipWhen;
}

export interface ArmyLoopTauntRuntimePriorityGroup {
  readonly assignments: readonly ArmyLoopTauntRuntimeAssignment[];
}

export type ArmyLoopTauntRuntimePlan =
  readonly ArmyLoopTauntRuntimePriorityGroup[];

/** Stops a Loop Taunt run early; map and script lifecycle changes stop it automatically. */
export interface ArmyLoopTauntHandle {
  /** Stops this run. Repeated calls are safe. */
  stop(): Effect.Effect<void>;
}

export class ArmyLoopTauntError extends Error {
  readonly _tag = "ArmyLoopTauntError";

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ArmyLoopTauntError";
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

interface LoopTauntSession {
  readonly playerNumber: number;
  readonly players: readonly string[];
  readonly sessionId: string;
}

interface NormalizedLoopTauntAssignment {
  readonly assignmentId: number;
  readonly players: readonly number[];
  readonly priorityGroupIndex: number;
  readonly query: MonsterQuery;
  readonly skipWhen?: ArmyLoopTauntRuntimeSkipWhen;
  readonly strategy: ArmyLoopTauntStrategy;
}

interface NormalizedLoopTauntPriorityGroup {
  readonly assignments: readonly NormalizedLoopTauntAssignment[];
}

interface LocalLoopTauntTarget extends NormalizedLoopTauntAssignment {
  readonly alive: boolean;
  readonly focusActive: boolean;
  readonly lifeRevision: number;
  readonly monsterMapId: number;
}

interface LoopTauntRun {
  readonly runId: string;
  readonly sessionId: string;
}

interface ActiveLoopTaunt {
  readonly done: Deferred.Deferred<void>;
  readonly ended: Deferred.Deferred<never, ArmyLoopTauntError>;
  readonly sessionId: string;
  readonly started: Ref.Ref<boolean>;
  readonly stopRequested: Deferred.Deferred<string>;
  readonly token: number;
}

// Commands can arrive after renderer state advances. Keep only the same target
// life while its priority is still selected and Focus remains uncovered.
const matchesTauntCommand = (
  targets: ReadonlyMap<number, LocalLoopTauntTarget>,
  command: Extract<
    ArmyLoopTauntCommandPayload["command"],
    { readonly type: "taunt" }
  >,
  playerNumber: number,
): LocalLoopTauntTarget | undefined => {
  const target = targets.get(command.assignmentId);
  if (
    target?.alive !== true ||
    !target.players.includes(playerNumber) ||
    target.monsterMapId !== command.monsterMapId ||
    target.lifeRevision !== command.lifeRevision ||
    (target.strategy.type === "focus" && target.focusActive)
  ) {
    return undefined;
  }

  const preempted = [...targets.values()].some(
    (candidate) =>
      candidate.priorityGroupIndex < target.priorityGroupIndex &&
      candidate.alive,
  );
  return preempted ? undefined : target;
};

const stopRecord = (
  active: ActiveLoopTaunt,
  reason: string,
): Effect.Effect<void> =>
  Deferred.succeed(active.stopRequested, reason).pipe(
    Effect.andThen(
      Ref.get(active.started).pipe(
        Effect.flatMap((started) =>
          started ? Deferred.await(active.done) : Effect.void,
        ),
      ),
    ),
    Effect.asVoid,
  );

const normalizeText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim() !== ""
    ? squashed.message
    : Cause.pretty(cause);
};

const fromDesktop = <A>(label: string, promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) => new ArmyLoopTauntError(label, cause),
  });

const failValidation = (message: string): never => {
  throw new ArmyLoopTauntError(message);
};

const normalizePlan = (
  plan: ArmyLoopTauntRuntimePlan,
  playerCount: number,
): readonly NormalizedLoopTauntPriorityGroup[] => {
  if (plan.length === 0) {
    failValidation("Loop Taunt requires at least one priority group");
  }

  let nextAssignmentId = 0;
  return plan.map((priorityGroup, priorityGroupIndex) => {
    if (priorityGroup.assignments.length === 0) {
      failValidation(
        `Loop Taunt priority group ${priorityGroupIndex + 1} requires at least one assignment`,
      );
    }

    const assignedPlayers = new Set<number>();
    return {
      assignments: priorityGroup.assignments.map(
        (assignment, assignmentIndex) => {
          const assignmentId = nextAssignmentId++;
          if (assignment.players.length === 0) {
            failValidation(
              `Loop Taunt priority group ${priorityGroupIndex + 1}, assignment ${assignmentIndex + 1} requires at least one player`,
            );
          }

          const players = [...assignment.players].toSorted(
            (left, right) => left - right,
          );
          const localPlayers = new Set<number>();
          for (const player of players) {
            if (
              !Number.isSafeInteger(player) ||
              player < 1 ||
              player > playerCount
            ) {
              failValidation(
                `Loop Taunt priority group ${priorityGroupIndex + 1}, assignment ${assignmentIndex + 1} contains an invalid Army player number: ${player}`,
              );
            }
            if (localPlayers.has(player)) {
              failValidation(
                `Loop Taunt priority group ${priorityGroupIndex + 1}, assignment ${assignmentIndex + 1} contains player ${player} more than once`,
              );
            }
            if (assignedPlayers.has(player)) {
              failValidation(
                `Loop Taunt player ${player} cannot be assigned more than once in priority group ${priorityGroupIndex + 1}`,
              );
            }
            localPlayers.add(player);
            assignedPlayers.add(player);
          }

          const strategy: ArmyLoopTauntStrategy =
            assignment.strategy.type === "focus"
              ? { type: "focus" }
              : {
                  message: assignment.strategy.message.trim(),
                  type: "message",
                };
          if (strategy.type === "message" && strategy.message === "") {
            failValidation(
              `Loop Taunt priority group ${priorityGroupIndex + 1}, assignment ${assignmentIndex + 1} requires a non-empty message`,
            );
          }
          return {
            assignmentId,
            players,
            priorityGroupIndex,
            query: assignment.target,
            ...(assignment.skipWhen === undefined
              ? {}
              : { skipWhen: assignment.skipWhen }),
            strategy,
          };
        },
      ),
    };
  });
};

const isFocusAura = (aura: {
  readonly icon: string | undefined;
  readonly name: string;
}): boolean =>
  normalizeText(aura.name) === LOOP_TAUNT_FOCUS_AURA_NAME &&
  aura.icon === LOOP_TAUNT_FOCUS_AURA_ICON;

const isFocusName = (name: string): boolean =>
  normalizeText(name) === LOOP_TAUNT_FOCUS_AURA_NAME;

const reportFailure = (cause: Cause.Cause<unknown>): ArmyLoopTauntReport => ({
  reason: causeMessage(cause),
  type: "failed",
});

const startupError = (cause: Cause.Cause<unknown>): ArmyLoopTauntError => {
  const error = Cause.squash(cause);
  return error instanceof ArmyLoopTauntError
    ? error
    : new ArmyLoopTauntError("Failed to start Loop Taunt", error);
};

const sameMap = (
  left: ArmyLoopTauntMapIdentity,
  right: ArmyLoopTauntMapIdentity,
): boolean =>
  left.id === right.id &&
  left.name === right.name &&
  left.roomNumber === right.roomNumber;

export interface ArmyLoopTauntRuntime {
  readonly notifySessionEnded: (
    payload: ArmySessionEndedPayload,
  ) => Effect.Effect<void>;
  readonly loopTaunt: (
    plan: ArmyLoopTauntRuntimePlan,
    onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>,
  ) => Effect.Effect<ArmyLoopTauntHandle, ArmyLoopTauntError>;
  readonly stopActive: (reason?: string) => Effect.Effect<void>;
}

export const makeArmyLoopTauntRuntime = (
  api: ApiService,
  bridge: DesktopArmyBridge,
  getSession: () => Effect.Effect<LoopTauntSession | null>,
): Effect.Effect<ArmyLoopTauntRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const activeRef = yield* SynchronizedRef.make<ActiveLoopTaunt | null>(null);
    const lifecycle = yield* Semaphore.make(1);
    const nextTokenRef = yield* Ref.make(0);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const stopActive = (reason = "Loop Taunt stopped") =>
      SynchronizedRef.get(activeRef).pipe(
        Effect.flatMap((active) =>
          active === null ? Effect.void : stopRecord(active, reason),
        ),
      );

    const notifySessionEnded = (payload: ArmySessionEndedPayload) =>
      SynchronizedRef.get(activeRef).pipe(
        Effect.flatMap((active) =>
          active?.sessionId === payload.sessionId
            ? Deferred.fail(
                active.ended,
                new ArmyLoopTauntError(
                  `Army session ended while Loop Taunt was active: ${payload.reason}`,
                ),
              ).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );

    const loopTaunt: ArmyLoopTauntRuntime["loopTaunt"] = (plan, onFailure) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* getSession();
          if (session === null) {
            return yield* Effect.fail(
              new ArmyLoopTauntError("Army must be started before Loop Taunt"),
            );
          }

          const normalizedPlan = yield* Effect.try({
            try: () => normalizePlan(plan, session.players.length),
            catch: (cause) =>
              cause instanceof ArmyLoopTauntError
                ? cause
                : new ArmyLoopTauntError("Invalid Loop Taunt plan", cause),
          });
          const normalizedAssignments = normalizedPlan.flatMap(
            ({ assignments }) => assignments,
          );

          const previous = yield* SynchronizedRef.get(activeRef);
          if (previous !== null) {
            yield* stopRecord(previous, "Loop Taunt was replaced");
          }

          const token = yield* Ref.updateAndGet(
            nextTokenRef,
            (value) => value + 1,
          );
          const done = yield* Deferred.make<void>();
          const ended = yield* Deferred.make<never, ArmyLoopTauntError>();
          const ready = yield* Deferred.make<void, ArmyLoopTauntError>();
          const startedRef = yield* Ref.make(false);
          const stopRequested = yield* Deferred.make<string>();
          const handle: ArmyLoopTauntHandle = {
            stop: () =>
              Deferred.succeed(stopRequested, "Loop Taunt handle stopped").pipe(
                Effect.andThen(Deferred.await(done)),
                Effect.asVoid,
              ),
          };
          const active: ActiveLoopTaunt = {
            done,
            ended,
            sessionId: session.sessionId,
            started: startedRef,
            stopRequested,
            token,
          };
          yield* SynchronizedRef.set(activeRef, active);

          const run = Effect.scoped(
            Effect.gen(function* () {
              const runScope = yield* Effect.scope;
              const startup = yield* Deferred.make<
                LoopTauntRun,
                ArmyLoopTauntError
              >();
              const mapExited = yield* Deferred.make<void>();

              const setup = Effect.gen(function* () {
                const mapIdentity: ArmyLoopTauntMapIdentity = yield* Effect.all(
                  {
                    id: api.map.getId(),
                    name: api.map.getName(),
                    roomNumber: api.map.getRoomNumber(),
                  },
                  { concurrency: "unbounded" },
                );

                const resolvedTargets = yield* Effect.forEach(
                  normalizedAssignments,
                  (assignment) =>
                    api.monsters.get(assignment.query).pipe(
                      Effect.flatMap((monster) =>
                        monster === null
                          ? Effect.fail(
                              new ArmyLoopTauntError(
                                `Loop Taunt could not resolve assignment ${assignment.assignmentId + 1}`,
                              ),
                            )
                          : Effect.succeed<LocalLoopTauntTarget>({
                              ...assignment,
                              alive: monster.alive,
                              focusActive: monster.auras.some(isFocusAura),
                              lifeRevision: 0,
                              monsterMapId: monster.monsterMapId,
                            }),
                      ),
                    ),
                  { concurrency: "unbounded" },
                ).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof ArmyLoopTauntError
                      ? cause
                      : new ArmyLoopTauntError(
                          "Failed to resolve Loop Taunt targets",
                          cause,
                        ),
                  ),
                );
                const uniqueMonsterMapIds = new Set(
                  resolvedTargets.map((target) => target.monsterMapId),
                );
                if (uniqueMonsterMapIds.size !== resolvedTargets.length) {
                  return yield* Effect.fail(
                    new ArmyLoopTauntError(
                      "Loop Taunt assignments must resolve to different monsters",
                    ),
                  );
                }

                const resolvedTargetsByAssignmentId = new Map(
                  resolvedTargets.map((target) => [
                    target.assignmentId,
                    target,
                  ]),
                );
                const targetsRef = yield* SynchronizedRef.make(
                  resolvedTargetsByAssignmentId,
                );
                const commandQueue =
                  yield* Queue.unbounded<ArmyLoopTauntCommandPayload>();
                let registeredRun: LoopTauntRun | undefined;

                // The last registration can synchronously activate the run, so
                // subscribe before crossing IPC and fence queued commands later.
                const disposeCommands = bridge.onLoopTauntCommand((command) => {
                  if (
                    command.sessionId === session.sessionId &&
                    (registeredRun === undefined ||
                      command.runId === registeredRun.runId)
                  ) {
                    runFork(
                      Queue.offer(commandQueue, command).pipe(Effect.asVoid),
                    );
                  }
                });
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    disposeCommands();
                  }),
                );

                const registration = yield* fromDesktop(
                  "Failed to register Loop Taunt",
                  () =>
                    bridge.loopTauntRegister({
                      map: mapIdentity,
                      priorityGroups: normalizedPlan.map((priorityGroup) => ({
                        assignments: priorityGroup.assignments.map(
                          (assignment) => {
                            const resolved = resolvedTargetsByAssignmentId.get(
                              assignment.assignmentId,
                            )!;
                            return {
                              assignmentId: resolved.assignmentId,
                              players: resolved.players,
                              strategy: resolved.strategy,
                              target: {
                                focusActive: resolved.focusActive,
                                lifeRevision: resolved.lifeRevision,
                                monsterMapId: resolved.monsterMapId,
                                state: resolved.alive ? "alive" : "dead",
                              },
                            };
                          },
                        ),
                      })),
                      sessionId: session.sessionId,
                    }),
                );
                const loopRun: LoopTauntRun = {
                  runId: registration.runId,
                  sessionId: session.sessionId,
                };
                registeredRun = loopRun;
                yield* Effect.addFinalizer(() =>
                  fromDesktop("Failed to leave Loop Taunt", () =>
                    bridge.loopTauntLeave({
                      reason: "Renderer Loop Taunt ended",
                      ...loopRun,
                    }),
                  ).pipe(Effect.catchCause(() => Effect.void)),
                );

                const rosterReady = fromDesktop(
                  "Failed while waiting for the Army Loop Taunt roster",
                  () => bridge.loopTauntReady(loopRun),
                );
                const startupInterrupted = Effect.raceFirst(
                  Deferred.await(mapExited).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        new ArmyLoopTauntError(
                          "The map changed while Loop Taunt was starting",
                        ),
                      ),
                    ),
                  ),
                  Effect.raceFirst(
                    Deferred.await(stopRequested).pipe(
                      Effect.flatMap((reason) =>
                        Effect.fail(new ArmyLoopTauntError(reason)),
                      ),
                    ),
                    Deferred.await(ended),
                  ),
                );
                yield* Effect.raceFirst(rosterReady, startupInterrupted);

                const finalMapIdentity: ArmyLoopTauntMapIdentity =
                  yield* Effect.all(
                    {
                      id: api.map.getId(),
                      name: api.map.getName(),
                      roomNumber: api.map.getRoomNumber(),
                    },
                    { concurrency: "unbounded" },
                  );
                if (!sameMap(mapIdentity, finalMapIdentity)) {
                  return yield* Effect.fail(
                    new ArmyLoopTauntError(
                      "The map changed while Loop Taunt was starting",
                    ),
                  );
                }

                const report = (report: ArmyLoopTauntReport) =>
                  fromDesktop("Failed to report Loop Taunt state", () =>
                    bridge.loopTauntReport({ ...loopRun, report }),
                  );
                const reportBestEffort = (value: ArmyLoopTauntReport) =>
                  report(value).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning({
                        cause,
                        message: "Loop Taunt report failed",
                      }),
                    ),
                  );

                const refreshTarget = (assignmentId: number) =>
                  Effect.gen(function* () {
                    const current = (yield* SynchronizedRef.get(
                      targetsRef,
                    )).get(assignmentId);
                    if (current === undefined) return;
                    const monster = yield* api.monsters.get(current.query);
                    const refreshed = yield* SynchronizedRef.modify(
                      targetsRef,
                      (targets) => {
                        const target = targets.get(assignmentId);
                        if (target === undefined) {
                          return [undefined, targets] as const;
                        }
                        if (monster === null) {
                          return [target, targets] as const;
                        }

                        const alive = monster.alive;
                        const focusActive = monster.auras.some(isFocusAura);
                        const monsterMapId = monster.monsterMapId;
                        if (
                          target.alive === alive &&
                          target.focusActive === focusActive &&
                          target.monsterMapId === monsterMapId
                        ) {
                          return [target, targets] as const;
                        }
                        const startedNewLife =
                          target.monsterMapId !== monsterMapId ||
                          (!target.alive && alive);
                        const next: LocalLoopTauntTarget = {
                          ...target,
                          alive,
                          focusActive,
                          // A life revision fences commands issued before a
                          // respawn or target-identity rebound.
                          lifeRevision:
                            target.lifeRevision + (startedNewLife ? 1 : 0),
                          monsterMapId,
                        };
                        return [
                          next,
                          new Map(targets).set(assignmentId, next),
                        ] as const;
                      },
                    );
                    if (refreshed === undefined) return;
                    yield* reportBestEffort({
                      assignmentId,
                      focusActive: refreshed.focusActive,
                      lifeRevision: refreshed.lifeRevision,
                      monsterMapId: refreshed.monsterMapId,
                      state: refreshed.alive ? "alive" : "dead",
                      type: "target-state",
                    });
                  });

                const updateTargetState = (
                  assignmentId: number,
                  monsterMapId: number,
                  alive: boolean,
                ) =>
                  Effect.gen(function* () {
                    const changed = yield* SynchronizedRef.modify(
                      targetsRef,
                      (targets) => {
                        const target = targets.get(assignmentId);
                        if (
                          target === undefined ||
                          target.monsterMapId !== monsterMapId
                        ) {
                          return [undefined, targets] as const;
                        }
                        const stateAlreadyCurrent =
                          target.alive === alive &&
                          (alive || !target.focusActive);
                        if (stateAlreadyCurrent) {
                          return [undefined, targets] as const;
                        }
                        const respawned = alive && !target.alive;
                        const resetFocus = !alive || respawned;
                        const next: LocalLoopTauntTarget = {
                          ...target,
                          alive,
                          lifeRevision:
                            target.lifeRevision + (respawned ? 1 : 0),
                          ...(resetFocus ? { focusActive: false } : {}),
                        };
                        return [
                          next,
                          new Map(targets).set(assignmentId, next),
                        ] as const;
                      },
                    );
                    if (changed === undefined) return;
                    yield* reportBestEffort({
                      assignmentId,
                      focusActive: changed.focusActive,
                      lifeRevision: changed.lifeRevision,
                      monsterMapId,
                      state: alive ? "alive" : "dead",
                      type: "target-state",
                    });
                  });

                const updateFocusState = (
                  assignmentId: number,
                  monsterMapId: number,
                  active: boolean,
                ) =>
                  Effect.gen(function* () {
                    const changed = yield* SynchronizedRef.modify(
                      targetsRef,
                      (targets) => {
                        const target = targets.get(assignmentId);
                        if (
                          target === undefined ||
                          target.strategy.type !== "focus" ||
                          target.monsterMapId !== monsterMapId ||
                          target.focusActive === active
                        ) {
                          return [undefined, targets] as const;
                        }
                        const next = {
                          ...target,
                          focusActive: active,
                        };
                        return [
                          next,
                          new Map(targets).set(assignmentId, next),
                        ] as const;
                      },
                    );
                    if (changed === undefined) return;
                    yield* reportBestEffort({
                      active,
                      assignmentId,
                      lifeRevision: changed.lifeRevision,
                      monsterMapId,
                      type: "focus-state",
                    });
                  });

                const assignmentIdsForMonster = (monsterMapId: number) =>
                  SynchronizedRef.get(targetsRef).pipe(
                    Effect.map((targets) =>
                      [...targets.values()]
                        .filter(
                          (target) => target.monsterMapId === monsterMapId,
                        )
                        .map((target) => target.assignmentId),
                    ),
                  );

                const onEvent = (event: Event) =>
                  Effect.gen(function* () {
                    switch (event.type) {
                      case "monster-death":
                      case "monster-respawn": {
                        const assignmentIds = yield* assignmentIdsForMonster(
                          event.monsterMapId,
                        );
                        yield* Effect.forEach(
                          assignmentIds,
                          (assignmentId) =>
                            updateTargetState(
                              assignmentId,
                              event.monsterMapId,
                              event.type === "monster-respawn",
                            ),
                          { discard: true },
                        );
                        return;
                      }
                      case "aura-added":
                      case "aura-updated":
                      case "aura-removed": {
                        if (
                          event.targetType !== "monster" ||
                          !isFocusName(event.name)
                        ) {
                          return;
                        }
                        const assignmentIds = yield* assignmentIdsForMonster(
                          event.targetId,
                        );
                        if (assignmentIds.length === 0) return;
                        const monster = yield* api.monsterLookup.get(
                          event.targetId,
                        );
                        const active =
                          monster?.auras.some(isFocusAura) ?? false;
                        yield* Effect.forEach(
                          assignmentIds,
                          (assignmentId) =>
                            updateFocusState(
                              assignmentId,
                              event.targetId,
                              active,
                            ),
                          { discard: true },
                        );
                        return;
                      }
                      case "update-message": {
                        const targets = yield* SynchronizedRef.get(targetsRef);
                        const candidates =
                          event.monsterMapId === undefined
                            ? [...targets.values()]
                            : [...targets.values()].filter(
                                (target) =>
                                  target.monsterMapId === event.monsterMapId,
                              );
                        yield* Effect.forEach(
                          candidates.filter(
                            (target) => target.strategy.type === "message",
                          ),
                          (target) =>
                            reportBestEffort({
                              assignmentId: target.assignmentId,
                              lifeRevision: target.lifeRevision,
                              message: event.message,
                              monsterMapId: target.monsterMapId,
                              source: event.source,
                              type: "message",
                            }),
                          { discard: true },
                        );
                        return;
                      }
                    }
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning({
                        cause,
                        message: "Loop Taunt event handling failed",
                      }),
                    ),
                  );

                const disposeEvents = yield* api.events.on(undefined, onEvent);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    disposeEvents();
                  }),
                );

                const assigned = normalizedAssignments.some((assignment) =>
                  assignment.players.includes(session.playerNumber),
                );
                const participantState = Effect.gen(function* () {
                  const [alive, item, cooldownMs] = yield* Effect.all([
                    api.player.isAlive(),
                    api.combat.getConsumableSkillItem(),
                    api.combat.getSkillCooldownRemainingMs(
                      LOOP_TAUNT_SCROLL_SKILL,
                    ),
                  ]);
                  const scrollEquipped =
                    item?.itemId === LOOP_TAUNT_SCROLL_ITEM_ID;
                  let reason: string | undefined;
                  if (!assigned) reason = "not-assigned";
                  else if (!alive) reason = "dead";
                  else if (!scrollEquipped) reason = "scroll-not-equipped";
                  else if (cooldownMs === null) reason = "cooldown-unavailable";
                  else if (cooldownMs > 0) reason = "cooldown";
                  else if (item?.ready !== true) reason = "scroll-not-ready";
                  return {
                    alive,
                    cooldownMs,
                    reason,
                    usable:
                      assigned &&
                      alive &&
                      scrollEquipped &&
                      cooldownMs !== null &&
                      (cooldownMs > 0 || item?.ready === true),
                  };
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ArmyLoopTauntError(
                        "Failed to read Loop Taunt readiness",
                        cause,
                      ),
                  ),
                );

                const reportParticipantState = Effect.gen(function* () {
                  const state = yield* participantState;
                  yield* report({
                    alive: state.alive,
                    cooldownMs: state.cooldownMs,
                    ...(state.reason === undefined
                      ? {}
                      : { reason: state.reason }),
                    type: "participant-state",
                    usable: state.usable,
                  });
                });

                const reportCommandResult = (
                  commandId: number,
                  outcome:
                    | "confirmed"
                    | "target-unavailable"
                    | "cast-failed"
                    | "not-ready"
                    | "skipped",
                  details?: {
                    readonly cooldownMs?: number | null;
                    readonly reason?: string;
                  },
                ) =>
                  reportBestEffort({
                    commandId,
                    ...(details?.cooldownMs === undefined
                      ? {}
                      : { cooldownMs: details.cooldownMs }),
                    outcome,
                    ...(details?.reason === undefined
                      ? {}
                      : { reason: details.reason }),
                    type: "command-result",
                  });
                const reportNotReady = (
                  commandId: number,
                  readiness: {
                    readonly cooldownMs: number | null;
                    readonly reason: string | undefined;
                  },
                ) =>
                  reportCommandResult(commandId, "not-ready", {
                    cooldownMs: readiness.cooldownMs,
                    ...(readiness.reason === undefined
                      ? {}
                      : { reason: readiness.reason }),
                  });

                const executeCommand = (payload: ArmyLoopTauntCommandPayload) =>
                  Effect.gen(function* () {
                    if (
                      payload.sessionId !== loopRun.sessionId ||
                      payload.runId !== loopRun.runId
                    ) {
                      return;
                    }
                    const command = payload.command;
                    switch (command.type) {
                      case "probe":
                        yield* reportParticipantState.pipe(
                          Effect.catchCause((cause) =>
                            reportBestEffort(reportFailure(cause)),
                          ),
                        );
                        return;
                      case "diagnostic":
                        yield* Effect.logWarning({
                          assignmentId: command.assignmentId,
                          code: command.code,
                          message: command.message,
                          runId: loopRun.runId,
                        });
                        return;
                      case "taunt":
                        yield* Effect.gen(function* () {
                          const target = matchesTauntCommand(
                            yield* SynchronizedRef.get(targetsRef),
                            command,
                            session.playerNumber,
                          );
                          if (target === undefined) {
                            yield* reportCommandResult(
                              payload.commandId,
                              "target-unavailable",
                            );
                            return;
                          }

                          const readiness = yield* participantState;
                          if (
                            !readiness.usable ||
                            readiness.cooldownMs === null ||
                            readiness.cooldownMs > 0
                          ) {
                            yield* reportNotReady(payload.commandId, readiness);
                            return;
                          }

                          if (target.skipWhen !== undefined) {
                            const participantSnapshots = yield* Effect.forEach(
                              target.players,
                              (playerNumber) =>
                                api.players
                                  .get(session.players[playerNumber - 1]!)
                                  .pipe(
                                    Effect.map((player) =>
                                      player === null
                                        ? null
                                        : {
                                            player: player.toJSON(),
                                            playerNumber,
                                          },
                                    ),
                                  ),
                              { concurrency: "unbounded" },
                            );
                            const unavailablePlayerNumbers =
                              target.players.filter(
                                (_, index) =>
                                  participantSnapshots[index] === null,
                              );
                            if (unavailablePlayerNumbers.length > 0) {
                              yield* reportCommandResult(
                                payload.commandId,
                                "not-ready",
                                {
                                  reason: `Army player snapshots unavailable: ${unavailablePlayerNumbers.join(", ")}`,
                                },
                              );
                              return;
                            }

                            const snapshots = participantSnapshots.filter(
                              (
                                participant,
                              ): participant is ArmyLoopTauntParticipantSnapshot =>
                                participant !== null,
                            );
                            const self = snapshots.find(
                              ({ playerNumber }) =>
                                playerNumber === session.playerNumber,
                            )!;
                            // Don't let user code consume the time needed to
                            // return a coordinator result.
                            const callbackBudgetMs = Math.min(
                              LOOP_TAUNT_SKIP_TIMEOUT_MS,
                              command.expiresAt -
                                (yield* Clock.currentTimeMillis) -
                                LOOP_TAUNT_COMMAND_REPORT_MARGIN_MS,
                            );
                            if (callbackBudgetMs <= 0) {
                              yield* reportCommandResult(
                                payload.commandId,
                                "not-ready",
                                {
                                  reason: "Loop Taunt command lease expired",
                                },
                              );
                              return;
                            }
                            const leaseLimitedCallback =
                              callbackBudgetMs < LOOP_TAUNT_SKIP_TIMEOUT_MS;
                            const skip = yield* target
                              .skipWhen({
                                participants: snapshots,
                                self,
                              })
                              .pipe(
                                Effect.timeoutOption(
                                  `${callbackBudgetMs} millis`,
                                ),
                              );
                            if (Option.isNone(skip)) {
                              yield* reportCommandResult(
                                payload.commandId,
                                "not-ready",
                                {
                                  reason: leaseLimitedCallback
                                    ? "Loop Taunt command lease expired"
                                    : "Loop Taunt skip callback timed out",
                                },
                              );
                              return;
                            }
                            if (skip.value) {
                              yield* reportCommandResult(
                                payload.commandId,
                                "skipped",
                              );
                              return;
                            }

                            const refreshedTarget = matchesTauntCommand(
                              yield* SynchronizedRef.get(targetsRef),
                              command,
                              session.playerNumber,
                            );
                            if (refreshedTarget === undefined) {
                              yield* reportCommandResult(
                                payload.commandId,
                                "target-unavailable",
                              );
                              return;
                            }
                            const currentReadiness = yield* participantState;
                            if (
                              !currentReadiness.usable ||
                              currentReadiness.cooldownMs === null ||
                              currentReadiness.cooldownMs > 0
                            ) {
                              yield* reportNotReady(
                                payload.commandId,
                                currentReadiness,
                              );
                              return;
                            }
                          }

                          if (
                            command.expiresAt -
                              (yield* Clock.currentTimeMillis) <
                            LOOP_TAUNT_CAST_LEASE_MS
                          ) {
                            yield* reportCommandResult(
                              payload.commandId,
                              "not-ready",
                              {
                                reason: "Loop Taunt command lease expired",
                              },
                            );
                            return;
                          }

                          // Readiness and skipWhen yield; target life and
                          // priority must be checked at dispatch.
                          const dispatchTarget = matchesTauntCommand(
                            yield* SynchronizedRef.get(targetsRef),
                            command,
                            session.playerNumber,
                          );
                          if (dispatchTarget === undefined) {
                            yield* reportCommandResult(
                              payload.commandId,
                              "target-unavailable",
                            );
                            return;
                          }

                          const previousTarget = yield* api.combat.target.get();
                          const result = yield* api.combat
                            .castConsumableOnMonster(
                              dispatchTarget.monsterMapId,
                              LOOP_TAUNT_SCROLL_ITEM_ID,
                            )
                            .pipe(
                              Effect.provideService(
                                ConsumableCastDispatchDeadline,
                                command.expiresAt - LOOP_TAUNT_CAST_LEASE_MS,
                              ),
                              Effect.catchCause(() => Effect.succeed(null)),
                            );
                          const cooldownMs =
                            yield* api.combat.getSkillCooldownRemainingMs(
                              LOOP_TAUNT_SCROLL_SKILL,
                            );
                          const confirmed =
                            result?.success === true &&
                            result.monsterMapId === dispatchTarget.monsterMapId;
                          const reason = confirmed
                            ? undefined
                            : result === null
                              ? "Scroll cast was not dispatched or its confirmation timed out"
                              : result.success === false
                                ? "Server rejected the scroll cast"
                                : "Scroll cast confirmed a different target";
                          if (reason !== undefined) {
                            yield* Effect.logWarning({
                              commandId: payload.commandId,
                              cooldownMs,
                              message: reason,
                              monsterMapId: dispatchTarget.monsterMapId,
                              playerNumber: session.playerNumber,
                            });
                          }
                          yield* reportCommandResult(
                            payload.commandId,
                            confirmed ? "confirmed" : "cast-failed",
                            {
                              cooldownMs,
                              ...(reason === undefined ? {} : { reason }),
                            },
                          );

                          const currentTarget = yield* api.combat.target.get();
                          // Restore only while selection still points at the
                          // cast target; a later target change wins.
                          if (
                            previousTarget?.type === "monster" &&
                            previousTarget.monsterMapId !==
                              dispatchTarget.monsterMapId &&
                            currentTarget?.type === "monster" &&
                            currentTarget.monsterMapId ===
                              dispatchTarget.monsterMapId
                          ) {
                            yield* api.combat
                              .attack(previousTarget.monsterMapId)
                              .pipe(
                                Effect.catchCause(() => Effect.succeed(false)),
                              );
                          }
                        });
                        return;
                    }
                  });

                yield* Effect.forever(
                  Queue.take(commandQueue).pipe(
                    Effect.flatMap(executeCommand),
                    Effect.catchCause((cause) =>
                      reportBestEffort(reportFailure(cause)),
                    ),
                  ),
                ).pipe(Effect.forkScoped);

                yield* Effect.forever(
                  // Equipment and consumable cooldown changes have no reliable
                  // event source, so readiness must be sampled while active.
                  reportParticipantState.pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning({
                        cause,
                        message: "Loop Taunt readiness report failed",
                      }),
                    ),
                    Effect.andThen(
                      Effect.sleep(`${LOOP_TAUNT_STATUS_INTERVAL_MS} millis`),
                    ),
                  ),
                ).pipe(Effect.forkScoped);

                // Events provide prompt transitions; polling repairs projection
                // updates missed during combat or reconnect churn.
                yield* Effect.forever(
                  Effect.forEach(
                    normalizedAssignments,
                    (assignment) => refreshTarget(assignment.assignmentId),
                    {
                      concurrency: "unbounded",
                      discard: true,
                    },
                  ).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning({
                        cause,
                        message: "Loop Taunt target refresh failed",
                      }),
                    ),
                    Effect.andThen(
                      Effect.sleep(`${LOOP_TAUNT_TARGET_INTERVAL_MS} millis`),
                    ),
                  ),
                ).pipe(Effect.forkScoped);

                return loopRun;
              });

              // Arm map exit before setup so a transition during target
              // resolution or registration cannot expose a stale run handle.
              const mapWatcher = api.events
                .once(
                  { type: "join-map" },
                  {
                    trigger: setup.pipe(
                      Effect.matchCauseEffect({
                        onFailure: (cause) =>
                          Deferred.failCause(startup, cause).pipe(
                            Effect.asVoid,
                          ),
                        onSuccess: (loopRun) =>
                          Deferred.succeed(startup, loopRun).pipe(
                            Effect.asVoid,
                          ),
                      }),
                      Effect.forkIn(runScope, {
                        startImmediately: true,
                      }),
                      Effect.as(true),
                    ),
                  },
                )
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) =>
                      Deferred.failCause(startup, cause).pipe(Effect.asVoid),
                    onSuccess: () =>
                      Deferred.succeed(mapExited, undefined).pipe(
                        Effect.asVoid,
                      ),
                  }),
                  Effect.forkScoped,
                );
              yield* mapWatcher;

              const loopRun = yield* Deferred.await(startup);
              // Let an exit published with startup win before exposing the run.
              yield* Effect.yieldNow;
              if (yield* Deferred.isDone(mapExited)) {
                return yield* Effect.fail(
                  new ArmyLoopTauntError(
                    "The map changed while Loop Taunt was starting",
                  ),
                );
              }

              yield* Ref.set(startedRef, true);
              yield* Deferred.succeed(ready, undefined);

              const terminal = fromDesktop(
                "Loop Taunt orchestration failed",
                () => bridge.loopTauntAwait(loopRun),
              ).pipe(
                Effect.flatMap((result) =>
                  result.status === "failed"
                    ? Effect.fail(new ArmyLoopTauntError(result.reason))
                    : Effect.void,
                ),
              );
              yield* Effect.raceFirst(
                Deferred.await(mapExited),
                Effect.raceFirst(
                  Deferred.await(stopRequested),
                  Effect.raceFirst(Deferred.await(ended), terminal),
                ),
              ).pipe(
                Effect.tapCause((cause) =>
                  Deferred.isDone(stopRequested).pipe(
                    Effect.flatMap((stopping) =>
                      stopping
                        ? Effect.void
                        : fromDesktop(
                            "Failed to report Loop Taunt failure",
                            () =>
                              bridge.loopTauntReport({
                                ...loopRun,
                                report: reportFailure(cause),
                              }),
                          ).pipe(Effect.catchCause(() => Effect.void)),
                    ),
                  ),
                ),
              );
            }),
          );

          const clearActive = SynchronizedRef.update(activeRef, (current) =>
            current?.token === token ? null : current,
          );
          const finish = (cause?: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              const started = yield* Ref.get(startedRef);
              if (!started) {
                yield* Deferred.fail(
                  ready,
                  cause === undefined
                    ? new ArmyLoopTauntError(
                        "Loop Taunt stopped before startup completed",
                      )
                    : startupError(cause),
                );
              }
              yield* clearActive;
              yield* Deferred.succeed(done, undefined);

              const stopping = yield* Deferred.isDone(stopRequested);
              if (cause !== undefined && started && !stopping) {
                yield* Effect.sync(() => {
                  runFork(onFailure(cause));
                });
              }
            });

          yield* run.pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => finish(cause),
              onSuccess: () => finish(),
            }),
            Effect.forkIn(scope),
          );

          return yield* Deferred.await(ready).pipe(
            Effect.tapError(() => Deferred.await(done)),
            Effect.onInterrupt(() =>
              Deferred.succeed(
                stopRequested,
                "Loop Taunt startup was interrupted",
              ).pipe(Effect.asVoid),
            ),
            Effect.as(handle),
          );
        }),
      );

    yield* Effect.addFinalizer(() =>
      stopActive("Loop Taunt runtime is shutting down"),
    );

    return {
      loopTaunt,
      notifySessionEnded,
      stopActive,
    };
  });
