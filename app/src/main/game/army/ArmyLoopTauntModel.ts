import type * as Deferred from "effect/Deferred";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  ArmyLoopTauntCommandPayload,
  ArmyLoopTauntMapIdentity,
  ArmyLoopTauntRegisterResult,
  ArmyLoopTauntResolvedTarget,
  ArmyLoopTauntStrategy,
  ArmyLoopTauntTerminalResult,
} from "@lucent/core/army";

export type ArmyParticipantId = number;

export interface ArmyAuthenticatedParticipant {
  readonly playerCount: number;
  readonly playerName: string;
  readonly playerNumber: number;
  readonly sessionId: string;
}

export const COMMAND_CONFIRMATION_TIMEOUT_MS = 7_000;
export const DEGRADED_AFTER_SWEEPS = 3;
export const DEGRADED_WARNING_MS = 3_000;
export const MESSAGE_DEDUPE_MS = 500;
export const REGISTRATION_TIMEOUT_MS = 30_000;
export const SWEEP_RETRY_MS = 1_000;

const LoopTauntReasons = Schema.Literals([
  "inactive-run",
  "already-registered",
  "registration-failed",
  "registration-mismatch",
  "invalid-registration",
  "invalid-report",
  "sender-mismatch",
]);

export class ArmyLoopTauntError extends Schema.TaggedError<ArmyLoopTauntError>()(
  "ArmyLoopTauntError",
  {
    reason: LoopTauntReasons,
    detail: Schema.String,
    runId: Schema.optionalKey(Schema.String),
    sessionId: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ArmyLoopTauntCommandEvent {
  readonly command: ArmyLoopTauntCommandPayload;
  readonly participantIds: readonly ArmyParticipantId[];
}

interface ParticipantReadiness {
  readonly alive: boolean;
  readonly readyAt: number;
  readonly usable: boolean;
}

export interface RunParticipant extends ArmyAuthenticatedParticipant {
  readonly id: ArmyParticipantId;
  readonly readiness?: ParticipantReadiness | undefined;
  readonly targets: ReadonlyMap<number, ArmyLoopTauntResolvedTarget>;
}

interface PendingTaunt {
  readonly commandId: number;
  readonly participantId: ArmyParticipantId;
}

interface TurnState {
  readonly attempted: ReadonlySet<ArmyParticipantId>;
  readonly failedSweeps: number;
  readonly hadFailure: boolean;
  readonly id: number;
  readonly pending?: PendingTaunt | undefined;
}

export interface DegradedState {
  readonly reason: "readiness" | "target-consensus";
  readonly revision: number;
}

interface PendingMessage {
  readonly lifeRevision: number;
  readonly monsterMapId: number;
  readonly observedAt: number;
}

export interface AssignmentState {
  readonly active: boolean;
  readonly assignmentId: number;
  readonly degradationRevision: number;
  readonly degraded?: DegradedState | undefined;
  readonly focusActive: boolean;
  readonly focusLossHandled: boolean;
  readonly lastMessageAt?: number | undefined;
  readonly lifeRevision: number;
  readonly monsterMapId: number;
  readonly nextPlayerOffset: number;
  readonly nextTurnId: number;
  readonly pendingLifeRevision?: number | undefined;
  readonly pendingMessage?: PendingMessage | undefined;
  readonly players: readonly number[];
  readonly strategy: ArmyLoopTauntStrategy;
  readonly targetState: "alive" | "dead" | "unresolved";
  readonly turn?: TurnState | undefined;
}

export interface RunState {
  readonly assignments: ReadonlyMap<number, AssignmentState>;
  readonly map: ArmyLoopTauntMapIdentity;
  readonly nextCommandId: number;
  readonly participants: ReadonlyMap<ArmyParticipantId, RunParticipant>;
  readonly playerCount: number;
  readonly priorityGroups: readonly (readonly number[])[];
  readonly readinessGate: Deferred.Deferred<
    ArmyLoopTauntRegisterResult,
    ArmyLoopTauntError
  >;
  readonly runId: string;
  readonly sessionId: string;
  readonly status: "collecting" | "active" | "terminal";
  readonly terminal?: ArmyLoopTauntTerminalResult | undefined;
  readonly terminalGate: Deferred.Deferred<ArmyLoopTauntTerminalResult>;
}

export interface LoopTauntSlot {
  readonly activeRunId?: string;
  readonly nextRunId: number;
  readonly runs: ReadonlyMap<string, RunState>;
}

export interface LoopTauntStep<A> {
  readonly slot: LoopTauntSlot;
  readonly effects: MutationEffects;
  readonly result: Result.Result<A, ArmyLoopTauntError>;
}

export const initialLoopTauntSlot: LoopTauntSlot = {
  nextRunId: 0,
  runs: new Map(),
};

export type ScheduledTimer = { readonly sessionId: string } & (
  | {
      readonly assignmentId: number;
      readonly commandId: number;
      readonly runId: string;
      readonly type: "command-timeout";
    }
  | {
      readonly runId: string;
      readonly type: "registration-timeout";
    }
  | {
      readonly assignmentId: number;
      readonly delayMs: number;
      readonly failedSweeps: number;
      readonly runId: string;
      readonly turnId: number;
      readonly type: "retry";
    }
  | {
      readonly assignmentId: number;
      readonly delayMs: number;
      readonly revision: number;
      readonly runId: string;
      readonly type: "degraded-warning";
    }
);

export type ReadinessEffect =
  | {
      readonly error: ArmyLoopTauntError;
      readonly gate: RunState["readinessGate"];
      readonly type: "fail";
    }
  | {
      readonly gate: RunState["readinessGate"];
      readonly result: ArmyLoopTauntRegisterResult;
      readonly sessionId: string;
      readonly type: "succeed";
    };

export interface MutationEffects {
  readonly commands: readonly ArmyLoopTauntCommandEvent[];
  readonly readiness: readonly ReadinessEffect[];
  readonly terminals: readonly {
    readonly gate: Deferred.Deferred<ArmyLoopTauntTerminalResult>;
    readonly result: ArmyLoopTauntTerminalResult;
  }[];
  readonly timers: readonly ScheduledTimer[];
}

export interface RunMutation extends MutationEffects {
  readonly run: RunState;
}

export const noEffects = (): MutationEffects => ({
  commands: [],
  readiness: [],
  terminals: [],
  timers: [],
});

export const mergeMutationEffects = (
  left: MutationEffects,
  right: MutationEffects,
): MutationEffects => ({
  commands: [...left.commands, ...right.commands],
  readiness: [...left.readiness, ...right.readiness],
  terminals: [...left.terminals, ...right.terminals],
  timers: [...left.timers, ...right.timers],
});

export const loopError = (
  reason: typeof LoopTauntReasons.Type,
  detail: string,
  sessionId: string,
  runId?: string,
) =>
  new ArmyLoopTauntError({
    reason,
    detail,
    sessionId,
    ...(runId === undefined ? {} : { runId }),
  });
