import type * as Deferred from "effect/Deferred";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  normalizeArmyPlayerKey,
  type ArmyConfigPayload,
  type ArmyProgressResult,
  type ArmySessionPayload,
} from "@lucent/core/army";

import { initialLoopTauntSlot, type LoopTauntSlot } from "./ArmyLoopTauntState";

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
  readonly loopTaunt: LoopTauntSlot;
  readonly nextStep: number;
  readonly checkpoint: (Checkpoint & { readonly step: number }) | null;
  readonly lastCompleted: StepSignature | null;
  readonly phase: "active";
  readonly startedAtMs: number;
}

export type ArmySessionState = CollectingSession | ActiveSession;

export type ArmySessionSnapshot =
  | CollectingSession
  | Omit<ActiveSession, "loopTaunt">;

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

export const normalizeTimeout = (value: number | undefined): number =>
  Number.isFinite(value)
    ? Math.max(1, Math.trunc(value!))
    : ARMY_SYNC_TIMEOUT_MS;

export const normalizeLabel = (label: string | undefined): string =>
  label === undefined ? "sync" : label;

export const sessionError = (
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

export const canonicalPlayerName = (
  config: ArmyConfigPayload,
  playerKey: string,
): string =>
  config.players.find(
    (player) => normalizeArmyPlayerKey(player) === playerKey,
  ) ?? playerKey;

export const playerNumber = (
  config: ArmyConfigPayload,
  playerKey: string,
): number =>
  config.players.findIndex(
    (player) => normalizeArmyPlayerKey(player) === playerKey,
  ) + 1;

export const playersWhere = (
  config: ArmyConfigPayload,
  predicate: (playerKey: string) => boolean,
): readonly string[] =>
  config.players.filter((player) => predicate(normalizeArmyPlayerKey(player)));

export const toPayload = (
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

export const checkpointName = (signature: StepSignature): string =>
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

export const unchanged = <A>(
  state: ArmyCoordinatorState,
  result: A,
): ArmyTransition<A> => ({ effects: [], result, state });

export const withSession = (
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
    loopTaunt: initialLoopTauntSlot,
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

export const identify = (
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
