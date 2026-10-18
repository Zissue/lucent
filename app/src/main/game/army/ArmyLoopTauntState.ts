import * as Result from "effect/Result";
import type {
  ArmyLoopTauntLeavePayload,
  ArmyLoopTauntMapIdentity,
  ArmyLoopTauntRegisterPayload,
  ArmyLoopTauntRegisterResult,
  ArmyLoopTauntReportPayload,
  ArmyLoopTauntResolvedTarget,
  ArmyLoopTauntRunPayload,
  ArmyLoopTauntStrategy,
} from "@lucent/core/army";
import {
  activateRun,
  attemptAssignment,
  issueCommand,
  priorityDecision,
  reconcileTopology,
  refreshAllAssignments,
  setAssignment,
  setParticipant,
  terminalize,
} from "./ArmyLoopTauntAssignments";
import {
  type ArmyAuthenticatedParticipant,
  type ArmyLoopTauntCommandEvent,
  ArmyLoopTauntError,
  type ArmyParticipantId,
  type AssignmentState,
  loopError,
  type LoopTauntSlot,
  type LoopTauntStep,
  mergeMutationEffects,
  type MutationEffects,
  noEffects,
  type ReadinessEffect,
  type RunState,
  type ScheduledTimer,
} from "./ArmyLoopTauntModel";
import { applyReport } from "./ArmyLoopTauntReports";

const uniqueNumbers = (values: readonly number[]): boolean =>
  new Set(values).size === values.length;

const sameNumbers = (
  left: readonly number[],
  right: readonly number[],
): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].toSorted((a, b) => a - b);
  const sortedRight = [...right].toSorted((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const sameStrategy = (
  left: ArmyLoopTauntStrategy,
  right: ArmyLoopTauntStrategy,
): boolean =>
  left.type === right.type &&
  (left.type === "focus" ||
    (right.type === "message" && left.message === right.message));

const sameMap = (
  left: ArmyLoopTauntMapIdentity,
  right: ArmyLoopTauntMapIdentity,
): boolean =>
  left.id === right.id &&
  left.name === right.name &&
  left.roomNumber === right.roomNumber;

const registrationAssignments = (payload: ArmyLoopTauntRegisterPayload) =>
  payload.priorityGroups.flatMap((group) => group.assignments);

const validateRegistration = (
  payload: ArmyLoopTauntRegisterPayload,
  playerCount: number,
): string | undefined => {
  if (payload.map.name.trim() === "") {
    return "Loop taunt map name must be non-empty";
  }
  if (payload.priorityGroups.length === 0) {
    return "Loop taunt requires at least one priority group";
  }
  if (payload.priorityGroups.some((group) => group.assignments.length === 0)) {
    return "Loop taunt priority groups must contain at least one assignment";
  }
  const assignments = registrationAssignments(payload);
  const assignmentIds = assignments.map(
    (assignment) => assignment.assignmentId,
  );
  if (
    assignmentIds.some(
      (assignmentId) => !Number.isSafeInteger(assignmentId) || assignmentId < 0,
    )
  ) {
    return "Loop taunt assignment IDs must be non-negative integers";
  }
  if (!uniqueNumbers(assignmentIds)) {
    return "Loop taunt assignment IDs must be unique";
  }
  for (const group of payload.priorityGroups) {
    const assignedPlayers = new Set<number>();
    for (const assignment of group.assignments) {
      if (
        assignment.players.length === 0 ||
        !uniqueNumbers(assignment.players)
      ) {
        return `Loop taunt assignment ${assignment.assignmentId} must contain unique players`;
      }
      for (const playerNumber of assignment.players) {
        if (
          !Number.isSafeInteger(playerNumber) ||
          playerNumber < 1 ||
          playerNumber > playerCount
        ) {
          return `Loop taunt assignment ${assignment.assignmentId} references player ${playerNumber} outside the Army roster`;
        }
        if (assignedPlayers.has(playerNumber)) {
          return `Loop taunt player ${playerNumber} appears in more than one assignment in the same priority group`;
        }
        assignedPlayers.add(playerNumber);
      }
      if (
        assignment.strategy.type === "message" &&
        assignment.strategy.message.trim() === ""
      ) {
        return `Loop taunt assignment ${assignment.assignmentId} requires a non-empty message`;
      }
    }
  }
  return undefined;
};

const targetsByAssignment = (
  payload: ArmyLoopTauntRegisterPayload,
): ReadonlyMap<number, ArmyLoopTauntResolvedTarget> =>
  new Map(
    registrationAssignments(payload).map((assignment) => [
      assignment.assignmentId,
      assignment.target,
    ]),
  );

const registrationMatches = (
  run: RunState,
  payload: ArmyLoopTauntRegisterPayload,
): string | undefined => {
  // Registrations must agree on the plan and target identity. Liveness and
  // Focus remain observer snapshots that are reconciled after activation.
  if (!sameMap(run.map, payload.map)) {
    return "Loop taunt map identity must match across the Army roster";
  }
  if (run.priorityGroups.length !== payload.priorityGroups.length) {
    return "Loop taunt priority groups must match across the Army roster";
  }
  const referenceParticipant = run.participants.values().next().value;
  for (const [groupIndex, incomingGroup] of payload.priorityGroups.entries()) {
    const assignmentIds = run.priorityGroups[groupIndex];
    if (
      assignmentIds === undefined ||
      assignmentIds.length !== incomingGroup.assignments.length
    ) {
      return "Loop taunt assignments and priority group boundaries must match across the Army roster";
    }
    for (const [
      assignmentIndex,
      incoming,
    ] of incomingGroup.assignments.entries()) {
      const assignmentId = assignmentIds[assignmentIndex];
      const assignment =
        assignmentId === undefined
          ? undefined
          : run.assignments.get(assignmentId);
      if (
        assignment === undefined ||
        assignment.assignmentId !== incoming.assignmentId ||
        !sameNumbers(assignment.players, incoming.players) ||
        !sameStrategy(assignment.strategy, incoming.strategy)
      ) {
        return "Loop taunt assignments and priority group boundaries must match across the Army roster";
      }
      const referenceTarget = referenceParticipant?.targets.get(
        incoming.assignmentId,
      );
      if (
        referenceTarget !== undefined &&
        (referenceTarget.monsterMapId !== incoming.target.monsterMapId ||
          referenceTarget.lifeRevision !== incoming.target.lifeRevision)
      ) {
        return "Loop taunt resolved targets must use the same monster map IDs and life revisions across the Army roster";
      }
    }
  }
  return undefined;
};

const storeRun = (slot: LoopTauntSlot, run: RunState): LoopTauntSlot => {
  const runs = new Map(slot.runs).set(run.runId, run);
  if (run.status === "terminal") {
    if (run.participants.size === 0) runs.delete(run.runId);
    if (slot.activeRunId === run.runId) {
      return { nextRunId: slot.nextRunId, runs };
    }
    return { ...slot, runs };
  }
  return { ...slot, activeRunId: run.runId, runs };
};

export const runForPayload = (
  state: LoopTauntSlot,
  payload: ArmyLoopTauntRunPayload,
  senderId: ArmyParticipantId,
): RunState | ArmyLoopTauntError => {
  const run = state.runs.get(payload.runId);
  if (run === undefined || run.sessionId !== payload.sessionId) {
    return loopError(
      "inactive-run",
      "Loop taunt run is not active",
      payload.sessionId,
      payload.runId,
    );
  }
  if (!run.participants.has(senderId)) {
    return loopError(
      "sender-mismatch",
      "Loop taunt sender is not registered for this run",
      payload.sessionId,
      payload.runId,
    );
  }
  return run;
};

const onCommandTimeout = (
  state: LoopTauntSlot,
  timer: Extract<ScheduledTimer, { readonly type: "command-timeout" }>,
  now: number,
): readonly [MutationEffects, LoopTauntSlot] => {
  const run = state.runs.get(timer.runId);
  const assignment = run?.assignments.get(timer.assignmentId);
  if (
    run === undefined ||
    run.status !== "active" ||
    assignment?.turn?.pending?.commandId !== timer.commandId
  ) {
    return [noEffects(), state];
  }
  const updated = setAssignment(run, {
    ...assignment,
    turn: {
      ...assignment.turn,
      hadFailure: true,
      pending: undefined,
    },
  });
  const mutation = attemptAssignment(updated, timer.assignmentId, now);
  return [mutation, storeRun(state, mutation.run)];
};

const onRetry = (
  state: LoopTauntSlot,
  timer: Extract<ScheduledTimer, { readonly type: "retry" }>,
  now: number,
): readonly [MutationEffects, LoopTauntSlot] => {
  const run = state.runs.get(timer.runId);
  const turn = run?.assignments.get(timer.assignmentId)?.turn;
  if (
    run === undefined ||
    run.status !== "active" ||
    turn === undefined ||
    turn.id !== timer.turnId ||
    turn.failedSweeps !== timer.failedSweeps ||
    turn.pending !== undefined
  ) {
    return [noEffects(), state];
  }
  const mutation = attemptAssignment(run, timer.assignmentId, now);
  return [mutation, storeRun(state, mutation.run)];
};

const onDegradedWarning = (
  state: LoopTauntSlot,
  timer: Extract<ScheduledTimer, { readonly type: "degraded-warning" }>,
): readonly [MutationEffects, LoopTauntSlot] => {
  const run = state.runs.get(timer.runId);
  const assignment = run?.assignments.get(timer.assignmentId);
  const degraded = assignment?.degraded;
  const unresolved =
    run === undefined
      ? false
      : priorityDecision(run).unresolvedAssignmentIds.has(timer.assignmentId);
  if (
    run === undefined ||
    run.status !== "active" ||
    assignment === undefined ||
    degraded?.reason !== "target-consensus" ||
    degraded.revision !== timer.revision ||
    !unresolved
  ) {
    return [noEffects(), state];
  }
  const [updated, command] = issueCommand(run, [...run.participants.keys()], {
    assignmentId: timer.assignmentId,
    code: "degraded",
    level: "warning",
    message: `Loop taunt target consensus is degraded for assignment ${timer.assignmentId}`,
    type: "diagnostic",
  });
  return [{ ...noEffects(), commands: [command] }, storeRun(state, updated)];
};

const onRegistrationTimeout = (
  state: LoopTauntSlot,
  timer: Extract<ScheduledTimer, { readonly type: "registration-timeout" }>,
): readonly [MutationEffects, LoopTauntSlot] => {
  const run = state.runs.get(timer.runId);
  if (run === undefined || run.status !== "collecting") {
    return [noEffects(), state];
  }
  const mutation = terminalize(run, {
    reason:
      "Loop taunt registration did not complete for the full Army roster within 30 seconds",
    status: "failed",
  });
  return [mutation, storeRun(state, mutation.run)];
};

const makeCollectingRun = (
  slot: LoopTauntSlot,
  payload: ArmyLoopTauntRegisterPayload,
  playerCount: number,
  gates: Pick<RunState, "readinessGate" | "terminalGate">,
): RunState => {
  const runId = `${payload.sessionId}:${slot.nextRunId}`;
  const registration = registrationAssignments(payload);
  const assignments = new Map<number, AssignmentState>(
    registration.map((assignment) => [
      assignment.assignmentId,
      {
        active: false,
        assignmentId: assignment.assignmentId,
        degradationRevision: 0,
        focusActive: assignment.target.focusActive,
        focusLossHandled: false,
        lifeRevision: assignment.target.lifeRevision,
        monsterMapId: assignment.target.monsterMapId,
        nextPlayerOffset: 0,
        nextTurnId: 0,
        players: [...assignment.players],
        strategy:
          assignment.strategy.type === "focus"
            ? { type: "focus" }
            : {
                message: assignment.strategy.message,
                type: "message",
              },
        targetState: assignment.target.state,
      },
    ]),
  );
  return {
    assignments,
    map: { ...payload.map },
    nextCommandId: 0,
    participants: new Map(),
    playerCount,
    priorityGroups: payload.priorityGroups.map((group) =>
      group.assignments.map((assignment) => assignment.assignmentId),
    ),
    readinessGate: gates.readinessGate,
    runId,
    sessionId: payload.sessionId,
    status: "collecting",
    terminalGate: gates.terminalGate,
  };
};

export const registerRun = (
  slot: LoopTauntSlot,
  payload: ArmyLoopTauntRegisterPayload,
  participant: ArmyAuthenticatedParticipant & {
    readonly id: ArmyParticipantId;
  },
  gates: Pick<RunState, "readinessGate" | "terminalGate">,
  now: number,
): LoopTauntStep<ArmyLoopTauntRegisterResult> => {
  const invalid = validateRegistration(payload, participant.playerCount);
  if (invalid !== undefined) {
    return {
      effects: noEffects(),
      result: Result.fail(
        loopError("invalid-registration", invalid, payload.sessionId),
      ),
      slot,
    };
  }
  let run =
    slot.activeRunId === undefined
      ? undefined
      : slot.runs.get(slot.activeRunId);
  let nextSlot = slot;
  let effects = noEffects();
  if (run?.status === "active") {
    const replaced = terminalize(run, { status: "completed" });
    nextSlot = storeRun(nextSlot, replaced.run);
    effects = mergeMutationEffects(effects, replaced);
    run = undefined;
  }
  if (run === undefined || run.status === "terminal") {
    run = makeCollectingRun(nextSlot, payload, participant.playerCount, gates);
    nextSlot = {
      ...nextSlot,
      activeRunId: run.runId,
      nextRunId: nextSlot.nextRunId + 1,
      runs: new Map(nextSlot.runs).set(run.runId, run),
    };
    effects = mergeMutationEffects(effects, {
      ...noEffects(),
      timers: [
        {
          runId: run.runId,
          sessionId: run.sessionId,
          type: "registration-timeout",
        },
      ],
    });
  } else {
    const mismatch = registrationMatches(run, payload);
    if (mismatch !== undefined) {
      return {
        effects: noEffects(),
        result: Result.fail(
          loopError(
            "registration-mismatch",
            mismatch,
            payload.sessionId,
            run.runId,
          ),
        ),
        slot,
      };
    }
  }
  if (run.playerCount !== participant.playerCount) {
    return {
      effects: noEffects(),
      result: Result.fail(
        loopError(
          "registration-mismatch",
          "Loop taunt roster size changed during registration",
          payload.sessionId,
          run.runId,
        ),
      ),
      slot,
    };
  }
  if (run.participants.has(participant.id)) {
    return {
      effects: noEffects(),
      result: Result.fail(
        loopError(
          "already-registered",
          "Loop taunt sender is already registered",
          payload.sessionId,
          run.runId,
        ),
      ),
      slot,
    };
  }
  run = setParticipant(run, {
    ...participant,
    targets: targetsByAssignment(payload),
  });
  if (run.participants.size === run.playerCount) {
    const activated = activateRun(run, now);
    run = activated.run;
    effects = mergeMutationEffects(effects, activated);
  }
  return {
    effects,
    result: Result.succeed({ runId: run.runId }),
    slot: storeRun(nextSlot, run),
  };
};

export const reportRun = (
  slot: LoopTauntSlot,
  payload: ArmyLoopTauntReportPayload,
  senderId: ArmyParticipantId,
  now: number,
): LoopTauntStep<void> => {
  const run = runForPayload(slot, payload, senderId);
  if (run instanceof ArmyLoopTauntError) {
    return { effects: noEffects(), result: Result.fail(run), slot };
  }
  const mutation = applyReport(run, senderId, payload.report, now);
  if (mutation instanceof ArmyLoopTauntError) {
    return { effects: noEffects(), result: Result.fail(mutation), slot };
  }
  return {
    effects: mutation,
    result: Result.succeed(undefined),
    slot: storeRun(slot, mutation.run),
  };
};

export const leaveRun = (
  slot: LoopTauntSlot,
  payload: ArmyLoopTauntLeavePayload,
  senderId: ArmyParticipantId,
  now: number,
): LoopTauntStep<void> => {
  const run = slot.runs.get(payload.runId);
  if (
    run === undefined ||
    run.sessionId !== payload.sessionId ||
    !run.participants.has(senderId)
  ) {
    return { effects: noEffects(), result: Result.succeed(undefined), slot };
  }
  const participants = new Map(run.participants);
  const participant = participants.get(senderId)!;
  participants.delete(senderId);
  let updated: RunState = { ...run, participants };
  if (run.status === "terminal") {
    return {
      effects: noEffects(),
      result: Result.succeed(undefined),
      slot: storeRun(slot, updated),
    };
  }
  if (run.status === "collecting") {
    const reason =
      payload.reason?.trim() ||
      `Loop taunt participant left during registration: ${participant.playerName}`;
    const mutation = terminalize(updated, { reason, status: "failed" });
    return {
      effects: mutation,
      result: Result.succeed(undefined),
      slot: storeRun(slot, mutation.run),
    };
  }
  if (participants.size === 0) {
    const mutation = terminalize(updated, { status: "completed" });
    return {
      effects: mutation,
      result: Result.succeed(undefined),
      slot: storeRun(slot, mutation.run),
    };
  }
  updated = refreshAllAssignments(updated);
  const reconciled = reconcileTopology(updated, now);
  return {
    effects: reconciled,
    result: Result.succeed(undefined),
    slot: storeRun(slot, reconciled.run),
  };
};

export const onTimer = (
  slot: LoopTauntSlot,
  timer: ScheduledTimer,
  now: number,
): LoopTauntStep<void> => {
  let transition: readonly [MutationEffects, LoopTauntSlot];
  switch (timer.type) {
    case "command-timeout":
      transition = onCommandTimeout(slot, timer, now);
      break;
    case "registration-timeout":
      transition = onRegistrationTimeout(slot, timer);
      break;
    case "retry":
      transition = onRetry(slot, timer, now);
      break;
    case "degraded-warning":
      transition = onDegradedWarning(slot, timer);
      break;
  }
  return {
    effects: transition[0],
    result: Result.succeed(undefined),
    slot: transition[1],
  };
};

export const commandForPublication = (
  slot: LoopTauntSlot | undefined,
  event: ArmyLoopTauntCommandEvent,
): ArmyLoopTauntCommandEvent | undefined => {
  const run = slot?.runs.get(event.command.runId);
  if (run?.status !== "active") return undefined;
  const participantIds = event.participantIds.filter((participantId) =>
    run.participants.has(participantId),
  );
  if (participantIds.length === 0) return undefined;
  const command = event.command.command;
  if (command.type === "taunt") {
    const pending = run.assignments.get(command.assignmentId)?.turn?.pending;
    if (
      pending?.commandId !== event.command.commandId ||
      pending.participantId !== participantIds[0] ||
      participantIds.length !== 1
    ) {
      return undefined;
    }
  } else if (
    command.type === "diagnostic" &&
    run.assignments.get(command.assignmentId)?.degraded === undefined
  ) {
    return undefined;
  }
  return { ...event, participantIds };
};

export const isReadinessCurrent = (
  slot: LoopTauntSlot | undefined,
  readiness: Extract<ReadinessEffect, { readonly type: "succeed" }>,
): boolean => {
  const run = slot?.runs.get(readiness.result.runId);
  return run?.status === "active" && run.readinessGate === readiness.gate;
};
