import { makeListenerRegistry } from "../../app/ListenerRegistry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  normalizeArmyPlayerKey,
  type ArmyConfigPayload,
  type ArmyProgressResult,
  type ArmySessionPayload,
} from "@lucent/core/army";

export const ARMY_START_TIMEOUT_MS = 120_000;
export const ARMY_SYNC_TIMEOUT_MS = 10 * 60_000;

const SessionReasons = Schema.Literals(["inactive", "not-started", "aborted"]);

export class ArmySessionError extends Schema.TaggedError<ArmySessionError>()(
  "ArmySessionError",
  {
    reason: SessionReasons,
    detail: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const ParticipantReasons = Schema.Literals([
  "not-configured",
  "already-joined",
  "sender-mismatch",
  "unavailable",
]);

export class ArmyParticipantError extends Schema.TaggedError<ArmyParticipantError>()(
  "ArmyParticipantError",
  {
    reason: ParticipantReasons,
    detail: Schema.String,
    playerName: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const SynchronizationReasons = Schema.Literals([
  "duplicate-arrival",
  "signature-mismatch",
  "completed-step",
  "invalid-step",
]);

export class ArmySynchronizationError extends Schema.TaggedError<ArmySynchronizationError>()(
  "ArmySynchronizationError",
  {
    reason: SynchronizationReasons,
    detail: Schema.String,
    label: Schema.optionalKey(Schema.String),
    sessionId: Schema.String,
    step: Schema.Int,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ArmyCoordinatorError =
  | ArmySessionError
  | ArmyParticipantError
  | ArmySynchronizationError;

export type ArmyParticipantId = number;

export interface ArmyParticipant {
  readonly rendererId: ArmyParticipantId;
  readonly isCurrent: () => boolean;
}

export type ArmySessionEndKind =
  | "application-quit"
  | "checkpoint-timeout"
  | "interrupted"
  | "participant-failed"
  | "participant-left"
  | "participant-unavailable"
  | "requested"
  | "start-timeout"
  | "synchronization-error";

export interface ArmySessionEndCause {
  readonly kind: ArmySessionEndKind;
  readonly reason: string;
}

export interface ArmySessionEndedEvent {
  readonly participantIds: readonly ArmyParticipantId[];
  readonly reason: string;
  readonly sessionId: string;
}

export interface ArmyAuthenticatedParticipant {
  readonly playerCount: number;
  readonly playerName: string;
  readonly playerNumber: number;
  readonly sessionId: string;
}

export type StartWaiter = Deferred.Deferred<void, ArmyCoordinatorError>;
export type StepWaiter = Deferred.Deferred<
  ArmyProgressResult,
  ArmyCoordinatorError
>;

export interface StepSignature {
  readonly kind: "barrier" | "progress";
  readonly label: string;
  readonly timeoutMs: number;
}

export interface Checkpoint {
  readonly ready: ReadonlyMap<string, boolean>;
  readonly signature: StepSignature;
  readonly waiters: readonly StepWaiter[];
}

interface SessionIdentity {
  readonly config: ArmyConfigPayload;
  readonly createdAtMs: number;
  readonly participants: ReadonlyMap<string, ArmyParticipantId>;
  readonly sessionId: string;
}

export interface CollectingSession extends SessionIdentity {
  readonly phase: "collecting";
  readonly waiters: readonly StartWaiter[];
}

export interface ActiveSession extends SessionIdentity {
  readonly nextStep: number;
  readonly checkpoint: (Checkpoint & { readonly step: number }) | null;
  readonly lastCompleted: StepSignature | null;
  readonly phase: "active";
  readonly startedAtMs: number;
}

export type ArmySessionState = CollectingSession | ActiveSession;

export interface ArmyCoordinatorState {
  readonly nextSessionId: number;
  readonly sessions: ReadonlyMap<string, ArmySessionState>;
}

export const initialCoordinatorState: ArmyCoordinatorState = {
  nextSessionId: 0,
  sessions: new Map(),
};

export type ArmyCoordinatorEffect =
  | {
      readonly type: "Started";
      readonly session: ActiveSession;
      readonly waiters: readonly StartWaiter[];
    }
  | {
      readonly type: "Released";
      readonly result: ArmyProgressResult;
      readonly waiters: readonly StepWaiter[];
    }
  | {
      readonly type: "Ended";
      readonly cause: ArmySessionEndCause;
      readonly endedAtMs: number;
      readonly session: ArmySessionState;
    };

export interface ArmyTransition<A> {
  readonly effects: readonly ArmyCoordinatorEffect[];
  readonly result: A;
  readonly state: ArmyCoordinatorState;
}

const normalizeTimeout = (value: number | undefined): number =>
  Number.isFinite(value)
    ? Math.max(1, Math.trunc(value!))
    : ARMY_SYNC_TIMEOUT_MS;

const normalizeLabel = (label: string | undefined): string =>
  label === undefined ? "sync" : label;

const sessionError = (
  reason: typeof SessionReasons.Type,
  detail: string,
  sessionId: string,
) => new ArmySessionError({ reason, detail, sessionId });

const participantError = (
  reason: typeof ParticipantReasons.Type,
  detail: string,
  sessionId: string,
  playerName?: string,
) =>
  new ArmyParticipantError({
    reason,
    detail,
    sessionId,
    ...(playerName === undefined ? {} : { playerName }),
  });

const syncError = (
  reason: typeof SynchronizationReasons.Type,
  detail: string,
  sessionId: string,
  step: number,
  label: string,
) => new ArmySynchronizationError({ reason, detail, label, sessionId, step });

const canonicalPlayerName = (
  config: ArmyConfigPayload,
  playerKey: string,
): string =>
  config.players.find(
    (player) => normalizeArmyPlayerKey(player) === playerKey,
  ) ?? playerKey;

const playerNumber = (config: ArmyConfigPayload, playerKey: string): number =>
  config.players.findIndex(
    (player) => normalizeArmyPlayerKey(player) === playerKey,
  ) + 1;

const playersWhere = (
  config: ArmyConfigPayload,
  predicate: (playerKey: string) => boolean,
): readonly string[] =>
  config.players.filter((player) => predicate(normalizeArmyPlayerKey(player)));

const toPayload = (
  config: ArmyConfigPayload,
  sessionId: string,
  playerKey: string,
): ArmySessionPayload => {
  const number = playerNumber(config, playerKey);
  return {
    configName: config.configName,
    items: config.items,
    playerName: canonicalPlayerName(config, playerKey),
    playerNumber: number,
    players: config.players,
    raw: config.raw,
    role: number === 1 ? "leader" : "member",
    room: config.room,
    sessionId,
    sets: config.sets,
  };
};

const sameSignature = (left: StepSignature, right: StepSignature): boolean =>
  left.kind === right.kind &&
  left.label === right.label &&
  left.timeoutMs === right.timeoutMs;

const signatureDescription = (signature: StepSignature): string =>
  `${signature.kind} ${signature.label}`;

const checkpointName = (signature: StepSignature): string =>
  signature.kind === "barrier" ? "sync" : "progress";

const isReady = (checkpoint: Checkpoint, playerKey: string): boolean =>
  checkpoint.ready.get(playerKey) === true;

const everyPlayer = (
  config: ArmyConfigPayload,
  predicate: (playerKey: string) => boolean,
): boolean =>
  config.players.every((player) => predicate(normalizeArmyPlayerKey(player)));

const progressResult = (
  config: ArmyConfigPayload,
  checkpoint: Checkpoint,
): ArmyProgressResult => {
  const pendingPlayers = playersWhere(
    config,
    (key) => !isReady(checkpoint, key),
  );
  return {
    complete: pendingPlayers.length === 0,
    completedPlayers: playersWhere(config, (key) => isReady(checkpoint, key)),
    pendingPlayers,
  };
};

const findSeat = (
  state: ArmyCoordinatorState,
  participantId: ArmyParticipantId,
):
  | { readonly playerKey: string; readonly session: ArmySessionState }
  | undefined => {
  for (const session of state.sessions.values()) {
    for (const [playerKey, id] of session.participants) {
      if (id === participantId) return { playerKey, session };
    }
  }
  return undefined;
};

const unchanged = <A>(
  state: ArmyCoordinatorState,
  result: A,
): ArmyTransition<A> => ({ effects: [], result, state });

const withSession = (
  state: ArmyCoordinatorState,
  session: ArmySessionState,
): ArmyCoordinatorState => ({
  ...state,
  sessions: new Map(state.sessions).set(session.sessionId, session),
});

export const endSession = (
  state: ArmyCoordinatorState,
  sessionId: string,
  cause: ArmySessionEndCause,
  nowMs: number,
): ArmyTransition<void> => {
  const session = state.sessions.get(sessionId);
  if (session === undefined) return unchanged(state, undefined);
  const sessions = new Map(state.sessions);
  sessions.delete(sessionId);
  return {
    effects: [{ type: "Ended", cause, endedAtMs: nowMs, session }],
    result: undefined,
    state: { ...state, sessions },
  };
};

const rejectAndEnd = (
  state: ArmyCoordinatorState,
  error: ArmySynchronizationError,
  nowMs: number,
): ArmyTransition<Result.Result<void, ArmyCoordinatorError>> => ({
  ...endSession(
    state,
    error.sessionId,
    { kind: "synchronization-error", reason: error.message },
    nowMs,
  ),
  result: Result.fail(error),
});

export const endParticipantSession = (
  state: ArmyCoordinatorState,
  participantId: ArmyParticipantId,
  cause: ArmySessionEndCause,
  nowMs: number,
): ArmyTransition<void> => {
  const seat = findSeat(state, participantId);
  return seat === undefined
    ? unchanged(state, undefined)
    : endSession(state, seat.session.sessionId, cause, nowMs);
};

export const leaveSession = (
  state: ArmyCoordinatorState,
  participantId: ArmyParticipantId,
  nowMs: number,
): ArmyTransition<void> => {
  const seat = findSeat(state, participantId);
  if (seat === undefined) return unchanged(state, undefined);
  const playerName = canonicalPlayerName(seat.session.config, seat.playerKey);
  return endSession(
    state,
    seat.session.sessionId,
    { kind: "participant-left", reason: `Army player left: ${playerName}` },
    nowMs,
  );
};

export const joinSession = (
  state: ArmyCoordinatorState,
  args: {
    readonly config: ArmyConfigPayload;
    readonly nowMs: number;
    readonly participantId: ArmyParticipantId;
    readonly playerName: string;
    readonly waiter: StartWaiter;
  },
): ArmyTransition<
  Result.Result<
    { readonly config: ArmyConfigPayload; readonly sessionId: string },
    ArmyCoordinatorError
  >
> => {
  const playerKey = normalizeArmyPlayerKey(args.playerName);
  const existing = [...state.sessions.values()].find(
    (session) => session.config.configName === args.config.configName,
  );
  const session: ArmySessionState = existing ?? {
    config: args.config,
    createdAtMs: args.nowMs,
    participants: new Map(),
    phase: "collecting",
    sessionId: `${args.nowMs.toString(36)}-${state.nextSessionId}`,
    waiters: [],
  };
  const reject = (error: ArmyCoordinatorError) =>
    unchanged(state, Result.fail(error));

  if (
    !session.config.players.some(
      (player) => normalizeArmyPlayerKey(player) === playerKey,
    )
  ) {
    return reject(
      participantError(
        "not-configured",
        `Player is not in army config: ${args.playerName}`,
        session.sessionId,
        args.playerName,
      ),
    );
  }
  const seat = findSeat(state, args.participantId);
  if (
    seat !== undefined &&
    (seat.session.sessionId !== session.sessionId ||
      seat.playerKey !== playerKey)
  ) {
    return reject(
      participantError(
        "already-joined",
        "Army window is already attached to another session",
        seat.session.sessionId,
        args.playerName,
      ),
    );
  }
  const holder = session.participants.get(playerKey);
  if (
    session.phase === "active" ||
    (holder !== undefined && holder !== args.participantId)
  ) {
    return reject(
      participantError(
        "already-joined",
        `Army player already joined: ${args.playerName}`,
        session.sessionId,
        args.playerName,
      ),
    );
  }

  const nextState: ArmyCoordinatorState =
    existing === undefined
      ? { ...state, nextSessionId: state.nextSessionId + 1 }
      : state;
  const participants = new Map(session.participants).set(
    playerKey,
    args.participantId,
  );
  const waiters = [...session.waiters, args.waiter];
  const result = Result.succeed({
    config: session.config,
    sessionId: session.sessionId,
  });
  if (participants.size < session.config.players.length) {
    return unchanged(
      withSession(nextState, { ...session, participants, waiters }),
      result,
    );
  }

  const active: ActiveSession = {
    nextStep: 0,
    checkpoint: null,
    lastCompleted: null,
    config: session.config,
    createdAtMs: session.createdAtMs,
    participants,
    phase: "active",
    sessionId: session.sessionId,
    startedAtMs: args.nowMs,
  };
  return {
    effects: [{ type: "Started", session: active, waiters }],
    result,
    state: withSession(nextState, active),
  };
};

export const expireStart = (
  state: ArmyCoordinatorState,
  sessionId: string,
  nowMs: number,
): ArmyTransition<void> => {
  const session = state.sessions.get(sessionId);
  if (session?.phase !== "collecting") return unchanged(state, undefined);
  const missing = playersWhere(
    session.config,
    (key) => !session.participants.has(key),
  );
  return endSession(
    state,
    sessionId,
    {
      kind: "start-timeout",
      reason: `Timed out waiting for army players; missing: ${missing.join(", ")}`,
    },
    nowMs,
  );
};

const identify = (
  state: ArmyCoordinatorState,
  sessionId: string,
  participantId: ArmyParticipantId,
): Result.Result<
  { readonly playerKey: string; readonly session: ActiveSession },
  ArmyCoordinatorError
> => {
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    return Result.fail(
      sessionError("inactive", "Army session is not active", sessionId),
    );
  }
  if (session.phase !== "active") {
    return Result.fail(
      sessionError("not-started", "Army session has not started", sessionId),
    );
  }
  for (const [playerKey, id] of session.participants) {
    if (id === participantId) return Result.succeed({ playerKey, session });
  }
  return Result.fail(
    participantError(
      "sender-mismatch",
      "Army sender is not attached to this session",
      sessionId,
    ),
  );
};

export const arriveAtStep = (
  state: ArmyCoordinatorState,
  args: {
    readonly complete: boolean;
    readonly nowMs: number;
    readonly participantId: ArmyParticipantId;
    readonly sessionId: string;
    readonly signature: StepSignature;
    readonly step: number;
    readonly waiter: StepWaiter;
  },
): ArmyTransition<Result.Result<void, ArmyCoordinatorError>> => {
  const { sessionId, signature, step } = args;
  if (!Number.isSafeInteger(step) || step < 0) {
    return unchanged(
      state,
      Result.fail(
        syncError(
          "invalid-step",
          "Army step must be a non-negative safe integer",
          sessionId,
          step,
          signature.label,
        ),
      ),
    );
  }
  const seat = identify(state, sessionId, args.participantId);
  if (Result.isFailure(seat))
    return unchanged(state, Result.fail(seat.failure));
  const { playerKey, session } = seat.success;
  const { config } = session;
  const ok = Result.succeed(undefined);

  if (step < session.nextStep) {
    if (
      step === session.nextStep - 1 &&
      signature.kind === "progress" &&
      session.lastCompleted !== null &&
      sameSignature(session.lastCompleted, signature)
    ) {
      return {
        effects: [
          {
            type: "Released",
            result: {
              complete: true,
              completedPlayers: config.players,
              pendingPlayers: [],
            },
            waiters: [args.waiter],
          },
        ],
        result: ok,
        state,
      };
    }
    return rejectAndEnd(
      state,
      syncError(
        "completed-step",
        `Army step ${step} has already completed`,
        sessionId,
        step,
        signature.label,
      ),
      args.nowMs,
    );
  }
  if (step > session.nextStep) {
    return rejectAndEnd(
      state,
      syncError(
        "signature-mismatch",
        `Army step mismatch: expected step ${session.nextStep}, received step ${step}`,
        sessionId,
        step,
        signature.label,
      ),
      args.nowMs,
    );
  }
  const existing = session.checkpoint;
  if (existing !== null && !sameSignature(existing.signature, signature)) {
    return rejectAndEnd(
      state,
      syncError(
        "signature-mismatch",
        `Army step mismatch for step ${step}: expected ${signatureDescription(existing.signature)}, got ${signatureDescription(signature)}`,
        sessionId,
        step,
        signature.label,
      ),
      args.nowMs,
    );
  }
  if (signature.kind === "barrier" && existing?.ready.has(playerKey)) {
    return rejectAndEnd(
      state,
      syncError(
        "duplicate-arrival",
        `Army player already reached sync ${step}: ${canonicalPlayerName(config, playerKey)}`,
        sessionId,
        step,
        signature.label,
      ),
      args.nowMs,
    );
  }

  const everyoneArrivedBefore =
    existing !== null && everyPlayer(config, (key) => existing.ready.has(key));
  const checkpoint: Checkpoint = {
    ready: new Map(existing?.ready).set(playerKey, args.complete),
    signature,
    waiters: [...(existing?.waiters ?? []), args.waiter],
  };
  const result = progressResult(config, checkpoint);
  const release =
    result.complete ||
    (!everyoneArrivedBefore &&
      everyPlayer(config, (key) => checkpoint.ready.has(key)));
  return {
    effects: release
      ? [{ type: "Released", result, waiters: checkpoint.waiters }]
      : [],
    result: ok,
    state: withSession(state, {
      ...session,
      nextStep: result.complete ? step + 1 : session.nextStep,
      checkpoint: result.complete
        ? null
        : { ...checkpoint, step, waiters: release ? [] : checkpoint.waiters },
      lastCompleted: result.complete ? signature : session.lastCompleted,
    }),
  };
};

export const expireStep = (
  state: ArmyCoordinatorState,
  sessionId: string,
  step: number,
  nowMs: number,
): ArmyTransition<void> => {
  const session = state.sessions.get(sessionId);
  if (session?.phase !== "active" || session.checkpoint?.step !== step) {
    return unchanged(state, undefined);
  }
  const checkpoint = session.checkpoint;
  const missing = playersWhere(
    session.config,
    (key) => !checkpoint.ready.has(key),
  );
  if (missing.length === 0) return unchanged(state, undefined);
  const notReady = playersWhere(
    session.config,
    (key) => checkpoint.ready.get(key) === false,
  );
  return endSession(
    state,
    sessionId,
    {
      kind: "checkpoint-timeout",
      reason: `Timed out waiting for army ${checkpointName(checkpoint.signature)} ${step} (${checkpoint.signature.label}); missing: ${missing.join(", ")}${notReady.length > 0 ? `; not ready: ${notReady.join(", ")}` : ""}`,
    },
    nowMs,
  );
};

export const failSession = (
  state: ArmyCoordinatorState,
  args: {
    readonly nowMs: number;
    readonly participantId: ArmyParticipantId;
    readonly reason: string;
    readonly sessionId: string;
  },
): ArmyTransition<Result.Result<void, ArmyCoordinatorError>> => {
  const seat = identify(state, args.sessionId, args.participantId);
  if (Result.isFailure(seat))
    return unchanged(state, Result.fail(seat.failure));
  const playerName = canonicalPlayerName(
    seat.success.session.config,
    seat.success.playerKey,
  );
  return {
    ...endSession(
      state,
      args.sessionId,
      {
        kind: "participant-failed",
        reason: `Army failed for ${playerName}: ${args.reason}`,
      },
      args.nowMs,
    ),
    result: Result.succeed(undefined),
  };
};

const rosterSnapshot = (session: ArmySessionState) =>
  session.config.players.map((playerName) => ({
    playerName,
    rendererId:
      session.participants.get(normalizeArmyPlayerKey(playerName)) ?? null,
  }));

const checkpointSnapshot = (session: ArmySessionState) =>
  session.phase === "collecting" || session.checkpoint === null
    ? []
    : [session.checkpoint].map((checkpoint) => ({
        arrivedPlayers: playersWhere(session.config, (key) =>
          checkpoint.ready.has(key),
        ),
        kind: checkpointName(checkpoint.signature),
        label: checkpoint.signature.label,
        missingPlayers: playersWhere(
          session.config,
          (key) => !checkpoint.ready.has(key),
        ),
        notReadyPlayers: playersWhere(
          session.config,
          (key) => checkpoint.ready.get(key) === false,
        ),
        step: checkpoint.step,
        timeoutMs: checkpoint.signature.timeoutMs,
      }));

const lastCompletedStep = (session: ArmySessionState): number | null =>
  session.phase === "collecting" || session.nextStep === 0
    ? null
    : session.nextStep - 1;

const isNormalSessionEnd = (cause: ArmySessionEndCause): boolean =>
  cause.kind === "application-quit" || cause.kind === "participant-left";

const writeEndLog = (
  effect: Extract<ArmyCoordinatorEffect, { readonly type: "Ended" }>,
) => {
  const { cause, session } = effect;
  const data = {
    cause,
    configName: session.config.configName,
    durationMs:
      effect.endedAtMs -
      (session.phase === "active" ? session.startedAtMs : session.createdAtMs),
    lastCompletedStep: lastCompletedStep(session),
    room: session.config.room,
    roster: rosterSnapshot(session),
    sessionId: session.sessionId,
    status: session.phase,
    ...(isNormalSessionEnd(cause)
      ? {}
      : { checkpoints: checkpointSnapshot(session) }),
  };
  return (
    isNormalSessionEnd(cause)
      ? Effect.logInfo("Army session ended")
      : Effect.logWarning("Army session ended")
  ).pipe(Effect.annotateLogs({ component: "army", data }));
};

export interface ArmyCoordinatorShape {
  readonly abortParticipant: (
    participantId: ArmyParticipantId,
    cause: ArmySessionEndCause,
  ) => Effect.Effect<void>;
  readonly abortSession: (
    sessionId: string,
    cause: ArmySessionEndCause,
  ) => Effect.Effect<void>;
  readonly fail: (
    sessionId: string,
    participantId: ArmyParticipantId,
    reason: string,
  ) => Effect.Effect<void, ArmyCoordinatorError>;
  readonly getSessions: () => Effect.Effect<readonly ArmySessionState[]>;
  readonly join: (
    config: ArmyConfigPayload,
    playerName: string,
    participant: ArmyParticipant,
  ) => Effect.Effect<ArmySessionPayload, ArmyCoordinatorError>;
  readonly leave: (participantId: ArmyParticipantId) => Effect.Effect<void>;
  readonly onSessionEnded: (
    listener: (event: ArmySessionEndedEvent) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<() => void>;
  readonly progress: (
    sessionId: string,
    participantId: ArmyParticipantId,
    payload: {
      readonly complete: boolean;
      readonly label?: string;
      readonly step: number;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<ArmyProgressResult, ArmyCoordinatorError>;
  readonly requireParticipant: (
    sessionId: string,
    participantId: ArmyParticipantId,
  ) => Effect.Effect<ArmyAuthenticatedParticipant, ArmyCoordinatorError>;
  readonly sync: (
    sessionId: string,
    participantId: ArmyParticipantId,
    payload: {
      readonly label?: string;
      readonly step: number;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<void, ArmyCoordinatorError>;
}

export class ArmyCoordinator extends Context.Service<
  ArmyCoordinator,
  ArmyCoordinatorShape
>()("lucent/internal/army/ArmyCoordinator") {}

export const makeArmyCoordinator = (): Effect.Effect<
  ArmyCoordinatorShape,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make(initialCoordinatorState);
    const sessionEndedEvents = makeListenerRegistry<ArmySessionEndedEvent>();

    const applyEffect = (
      effect: ArmyCoordinatorEffect,
    ): Effect.Effect<void> => {
      if (effect.type === "Started") {
        return Effect.forEach(
          effect.waiters,
          (waiter) => Deferred.succeed(waiter, undefined),
          { discard: true },
        ).pipe(
          Effect.andThen(
            Effect.logInfo("Army session started").pipe(
              Effect.annotateLogs({
                component: "army",
                data: {
                  configName: effect.session.config.configName,
                  room: effect.session.config.room,
                  roster: rosterSnapshot(effect.session),
                  sessionId: effect.session.sessionId,
                },
              }),
            ),
          ),
        );
      }
      if (effect.type === "Released") {
        return Effect.forEach(
          effect.waiters,
          (waiter) => Deferred.succeed(waiter, effect.result),
          { discard: true },
        );
      }
      return Effect.gen(function* () {
        const { cause, session } = effect;
        const error = sessionError("aborted", cause.reason, session.sessionId);
        if (session.phase === "collecting") {
          yield* Effect.forEach(
            session.waiters,
            (waiter) => Deferred.fail(waiter, error),
            { discard: true },
          );
        } else {
          yield* Effect.forEach(
            session.checkpoint?.waiters ?? [],
            (waiter) => Deferred.fail(waiter, error),
            { discard: true },
          );
        }
        yield* sessionEndedEvents.publish({
          participantIds: [...session.participants.values()],
          reason: cause.reason,
          sessionId: session.sessionId,
        });
        yield* Effect.suspend(() => writeEndLog(effect)).pipe(
          Effect.ignoreCause,
        );
      });
    };

    const dispatch = <A>(
      transition: (
        state: ArmyCoordinatorState,
        nowMs: number,
      ) => ArmyTransition<A>,
    ): Effect.Effect<A> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const next = yield* Ref.modify(stateRef, (state) => {
            const applied = transition(state, nowMs);
            return [applied, applied.state] as const;
          });
          yield* Effect.forEach(next.effects, applyEffect, { discard: true });
          return next.result;
        }),
      );

    const awaitWaiter = <A>(args: {
      readonly restore: (
        effect: Effect.Effect<A, ArmyCoordinatorError>,
      ) => Effect.Effect<A, ArmyCoordinatorError>;
      readonly expire: (
        state: ArmyCoordinatorState,
        nowMs: number,
      ) => ArmyTransition<void>;
      readonly interruptReason: string;
      readonly sessionId: string;
      readonly timeoutMs: number;
      readonly waiter: Deferred.Deferred<A, ArmyCoordinatorError>;
    }): Effect.Effect<A, ArmyCoordinatorError> =>
      Deferred.await(args.waiter).pipe(
        Effect.timeoutOption(args.timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              dispatch(args.expire).pipe(
                Effect.andThen(Deferred.await(args.waiter)),
              ),
            onSome: Effect.succeed,
          }),
        ),
        args.restore,
        Effect.onInterrupt(() =>
          dispatch((state, nowMs) =>
            endSession(
              state,
              args.sessionId,
              { kind: "interrupted", reason: args.interruptReason },
              nowMs,
            ),
          ),
        ),
      );

    const join: ArmyCoordinatorShape["join"] = (
      config,
      playerName,
      participant,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const waiter = yield* Deferred.make<void, ArmyCoordinatorError>();
          const joined = yield* dispatch((state, nowMs) =>
            participant.isCurrent()
              ? joinSession(state, {
                  config,
                  nowMs,
                  participantId: participant.rendererId,
                  playerName,
                  waiter,
                })
              : unchanged(
                  state,
                  Result.fail(
                    new ArmyParticipantError({
                      reason: "unavailable",
                      detail: "Army window is no longer available",
                      playerName,
                    }),
                  ),
                ),
          ).pipe(Effect.flatMap(Effect.fromResult));
          yield* awaitWaiter({
            restore,
            expire: (state, nowMs) =>
              expireStart(state, joined.sessionId, nowMs),
            interruptReason: "Army start interrupted",
            sessionId: joined.sessionId,
            timeoutMs: ARMY_START_TIMEOUT_MS,
            waiter,
          });
          return toPayload(
            joined.config,
            joined.sessionId,
            normalizeArmyPlayerKey(playerName),
          );
        }),
      );

    const arrive = (
      sessionId: string,
      participantId: ArmyParticipantId,
      step: number,
      signature: StepSignature,
      complete: boolean,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const waiter = yield* Deferred.make<
            ArmyProgressResult,
            ArmyCoordinatorError
          >();
          yield* dispatch((state, nowMs) =>
            arriveAtStep(state, {
              complete,
              nowMs,
              participantId,
              sessionId,
              signature,
              step,
              waiter,
            }),
          ).pipe(Effect.flatMap(Effect.fromResult));
          return yield* awaitWaiter({
            restore,
            expire: (state, nowMs) => expireStep(state, sessionId, step, nowMs),
            interruptReason: `Army ${checkpointName(signature)} interrupted`,
            sessionId,
            timeoutMs: signature.timeoutMs,
            waiter,
          });
        }),
      );

    const sync: ArmyCoordinatorShape["sync"] = (
      sessionId,
      participantId,
      payload,
    ) =>
      arrive(
        sessionId,
        participantId,
        payload.step,
        {
          kind: "barrier",
          label: normalizeLabel(payload.label),
          timeoutMs: normalizeTimeout(payload.timeoutMs),
        },
        true,
      ).pipe(Effect.asVoid);

    const progress: ArmyCoordinatorShape["progress"] = (
      sessionId,
      participantId,
      payload,
    ) =>
      arrive(
        sessionId,
        participantId,
        payload.step,
        {
          kind: "progress",
          label: normalizeLabel(payload.label),
          timeoutMs: normalizeTimeout(payload.timeoutMs),
        },
        payload.complete,
      );

    const requireParticipant: ArmyCoordinatorShape["requireParticipant"] = (
      sessionId,
      participantId,
    ) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          Effect.fromResult(identify(state, sessionId, participantId)),
        ),
        Effect.map(({ playerKey, session }) => ({
          playerCount: session.config.players.length,
          playerName: canonicalPlayerName(session.config, playerKey),
          playerNumber: playerNumber(session.config, playerKey),
          sessionId,
        })),
      );

    const abortSession: ArmyCoordinatorShape["abortSession"] = (
      sessionId,
      cause,
    ) => dispatch((state, nowMs) => endSession(state, sessionId, cause, nowMs));

    const getSessions: ArmyCoordinatorShape["getSessions"] = () =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => [...state.sessions.values()]),
      );

    const service: ArmyCoordinatorShape = {
      abortParticipant: (participantId, cause) =>
        dispatch((state, nowMs) =>
          endParticipantSession(state, participantId, cause, nowMs),
        ),
      abortSession,
      fail: (sessionId, participantId, reason) =>
        dispatch((state, nowMs) =>
          failSession(state, { nowMs, participantId, reason, sessionId }),
        ).pipe(Effect.flatMap(Effect.fromResult)),
      getSessions,
      join,
      leave: (participantId) =>
        dispatch((state, nowMs) => leaveSession(state, participantId, nowMs)),
      onSessionEnded: sessionEndedEvents.subscribe,
      progress,
      requireParticipant,
      sync,
    };

    yield* Effect.addFinalizer(() =>
      getSessions().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(
            sessions,
            (session) =>
              abortSession(session.sessionId, {
                kind: "application-quit",
                reason: "Application is quitting",
              }),
            { discard: true },
          ),
        ),
      ),
    );

    return service;
  });

export const layer = Layer.effect(ArmyCoordinator, makeArmyCoordinator());
