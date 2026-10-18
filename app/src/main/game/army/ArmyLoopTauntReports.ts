import type { ArmyLoopTauntReport } from "@lucent/core/army";
import {
  assignmentRing,
  attemptAssignment,
  isReady,
  matchesMessage,
  reconcileTopology,
  recoverAssignment,
  refreshAssignmentFromTargets,
  refreshPriorityGroup,
  setAssignment,
  setParticipant,
  startTurn,
  terminalize,
} from "./ArmyLoopTauntAssignments";
import {
  type ArmyLoopTauntError,
  type ArmyParticipantId,
  type AssignmentState,
  loopError,
  mergeMutationEffects,
  MESSAGE_DEDUPE_MS,
  type MutationEffects,
  noEffects,
  type RunMutation,
  type RunParticipant,
  type RunState,
} from "./ArmyLoopTauntModel";

const validateTargetReport = (
  run: RunState,
  participant: RunParticipant,
  report: Extract<
    ArmyLoopTauntReport,
    {
      readonly assignmentId: number;
      readonly lifeRevision: number;
      readonly monsterMapId: number;
    }
  >,
): ArmyLoopTauntError | undefined => {
  const target = participant.targets.get(report.assignmentId);
  if (
    target === undefined ||
    target.monsterMapId !== report.monsterMapId ||
    target.lifeRevision !== report.lifeRevision
  ) {
    return loopError(
      "invalid-report",
      `Loop taunt report does not match the sender target life for assignment ${report.assignmentId}`,
      run.sessionId,
      run.runId,
    );
  }
  return undefined;
};

const applyParticipantState = (
  inputRun: RunState,
  participantId: ArmyParticipantId,
  report: Extract<ArmyLoopTauntReport, { readonly type: "participant-state" }>,
  now: number,
): RunMutation => {
  const current = inputRun.participants.get(participantId)!;
  const cooldownMs = report.cooldownMs ?? 0;
  const updatedParticipant: RunParticipant = {
    ...current,
    readiness: {
      alive: report.alive,
      readyAt: now + cooldownMs,
      usable: report.usable,
    },
  };
  let run = setParticipant(inputRun, updatedParticipant);
  let effects: MutationEffects = noEffects();
  const previousReadiness = current.readiness;
  const readinessImproved =
    previousReadiness !== undefined &&
    report.alive &&
    report.usable &&
    (!previousReadiness.alive ||
      !previousReadiness.usable ||
      updatedParticipant.readiness!.readyAt < previousReadiness.readyAt);
  const assignmentsToAttempt = new Set<number>();

  const assignments = new Map(run.assignments);
  for (const [assignmentId, assignment] of assignments) {
    if (
      !assignment.players.includes(current.playerNumber) ||
      assignment.turn === undefined
    ) {
      continue;
    }
    if (
      assignment.turn.pending?.participantId === participantId &&
      (!report.alive || !report.usable)
    ) {
      assignments.set(assignmentId, {
        ...assignment,
        turn: {
          ...assignment.turn,
          hadFailure: true,
          pending: undefined,
        },
      });
      assignmentsToAttempt.add(assignmentId);
      continue;
    }
    if (
      readinessImproved &&
      isReady(updatedParticipant, now) &&
      assignment.turn.pending === undefined
    ) {
      const attempted = new Set(assignment.turn.attempted);
      attempted.delete(participantId);
      assignments.set(assignmentId, {
        ...assignment,
        turn: {
          ...assignment.turn,
          attempted,
        },
      });
      assignmentsToAttempt.add(assignmentId);
    }
  }
  run = { ...run, assignments };
  if (previousReadiness === undefined) {
    for (const [assignmentId, assignment] of run.assignments) {
      if (
        assignment.turn !== undefined &&
        assignment.players.includes(current.playerNumber) &&
        assignmentRing(run, assignment).every(
          (participant) => participant.readiness !== undefined,
        )
      ) {
        assignmentsToAttempt.add(assignmentId);
      }
    }
  }

  for (const assignmentId of assignmentsToAttempt) {
    const attempted = attemptAssignment(run, assignmentId, now);
    run = attempted.run;
    effects = mergeMutationEffects(effects, attempted);
  }
  return { ...effects, run };
};

const applyTargetState = (
  inputRun: RunState,
  participant: RunParticipant,
  report: Extract<ArmyLoopTauntReport, { readonly type: "target-state" }>,
  now: number,
): RunMutation | ArmyLoopTauntError => {
  const existingTarget = participant.targets.get(report.assignmentId);
  if (existingTarget === undefined) {
    return loopError(
      "invalid-report",
      `Loop taunt target state does not match sender assignment ${report.assignmentId}`,
      inputRun.sessionId,
      inputRun.runId,
    );
  }
  if (report.lifeRevision < existingTarget.lifeRevision) {
    return { ...noEffects(), run: inputRun };
  }
  if (
    report.lifeRevision === existingTarget.lifeRevision &&
    report.monsterMapId !== existingTarget.monsterMapId
  ) {
    return loopError(
      "invalid-report",
      `Loop taunt target map changed without a new life revision for assignment ${report.assignmentId}`,
      inputRun.sessionId,
      inputRun.runId,
    );
  }
  const rebound = existingTarget.monsterMapId !== report.monsterMapId;
  const participantLifeChanged =
    existingTarget.lifeRevision !== report.lifeRevision;
  const resetFocus =
    participantLifeChanged ||
    rebound ||
    (existingTarget.state === "dead" && report.state === "alive");
  const focusActive =
    report.focusActive ?? (resetFocus ? false : existingTarget.focusActive);
  if (
    existingTarget.state === report.state &&
    existingTarget.monsterMapId === report.monsterMapId &&
    existingTarget.lifeRevision === report.lifeRevision &&
    existingTarget.focusActive === focusActive
  ) {
    return { ...noEffects(), run: inputRun };
  }

  let run = setParticipant(inputRun, {
    ...participant,
    targets: new Map(participant.targets).set(report.assignmentId, {
      focusActive,
      lifeRevision: report.lifeRevision,
      monsterMapId: report.monsterMapId,
      state: report.state,
    }),
  });
  run = refreshAssignmentFromTargets(run, report.assignmentId);
  run = refreshPriorityGroup(run);
  return reconcileTopology(run, now);
};

const applyFocusState = (
  inputRun: RunState,
  participant: RunParticipant,
  report: Extract<ArmyLoopTauntReport, { readonly type: "focus-state" }>,
  now: number,
): RunMutation | ArmyLoopTauntError => {
  const invalid = validateTargetReport(inputRun, participant, report);
  if (invalid !== undefined) return invalid;
  const current = inputRun.assignments.get(report.assignmentId)!;
  if (
    current.targetState !== "alive" ||
    current.monsterMapId !== report.monsterMapId ||
    current.lifeRevision !== report.lifeRevision
  ) {
    return { ...noEffects(), run: inputRun };
  }
  const target = participant.targets.get(report.assignmentId)!;
  if (target.focusActive === report.active) {
    return { ...noEffects(), run: inputRun };
  }
  let run = setParticipant(inputRun, {
    ...participant,
    targets: new Map(participant.targets).set(report.assignmentId, {
      ...target,
      focusActive: report.active,
    }),
  });
  run = refreshAssignmentFromTargets(run, report.assignmentId);
  run = refreshPriorityGroup(run);
  let assignment = run.assignments.get(report.assignmentId)!;
  if (assignment.strategy.type !== "focus") {
    return { ...noEffects(), run };
  }
  if (assignment.focusActive) {
    assignment = {
      ...recoverAssignment(assignment),
      focusLossHandled: false,
      turn: undefined,
    };
  } else if (assignment.active && !assignment.focusLossHandled) {
    assignment = {
      ...startTurn(assignment),
      focusLossHandled: true,
    };
  }
  run = setAssignment(run, assignment);
  return attemptAssignment(run, report.assignmentId, now);
};

const applyMessage = (
  inputRun: RunState,
  participant: RunParticipant,
  report: Extract<ArmyLoopTauntReport, { readonly type: "message" }>,
  now: number,
): RunMutation | ArmyLoopTauntError => {
  const invalid = validateTargetReport(inputRun, participant, report);
  if (invalid !== undefined) return invalid;
  const current = inputRun.assignments.get(report.assignmentId)!;
  if (
    current.strategy.type !== "message" ||
    !matchesMessage(report.message, current.strategy.message)
  ) {
    return { ...noEffects(), run: inputRun };
  }
  const senderTarget = participant.targets.get(report.assignmentId)!;
  if (!current.active && current.targetState === "alive") {
    return { ...noEffects(), run: inputRun };
  }
  if (
    !current.active ||
    current.monsterMapId !== report.monsterMapId ||
    current.lifeRevision !== report.lifeRevision
  ) {
    if (senderTarget.state !== "alive") {
      return { ...noEffects(), run: inputRun };
    }
    // Encounter messages can arrive before target-life consensus. Retain one
    // trigger for the life that may become active.
    const pending = current.pendingMessage;
    const shouldReplacePending =
      pending === undefined ||
      report.lifeRevision > pending.lifeRevision ||
      (report.lifeRevision === pending.lifeRevision &&
        report.monsterMapId !== pending.monsterMapId);
    return {
      ...noEffects(),
      run: setAssignment(inputRun, {
        ...current,
        pendingMessage: shouldReplacePending
          ? {
              lifeRevision: report.lifeRevision,
              monsterMapId: report.monsterMapId,
              observedAt: now,
            }
          : pending,
      }),
    };
  }
  if (
    current.lastMessageAt !== undefined &&
    now - current.lastMessageAt < MESSAGE_DEDUPE_MS
  ) {
    return { ...noEffects(), run: inputRun };
  }
  let assignment: AssignmentState = {
    ...current,
    lastMessageAt: now,
  };
  if (assignment.turn === undefined) assignment = startTurn(assignment);
  const run = setAssignment(inputRun, assignment);
  return reconcileTopology(run, now);
};

const applyCommandResult = (
  inputRun: RunState,
  participantId: ArmyParticipantId,
  report: Extract<ArmyLoopTauntReport, { readonly type: "command-result" }>,
  now: number,
): RunMutation => {
  const pendingEntry = [...inputRun.assignments].find(
    ([, assignment]) =>
      assignment.turn?.pending?.commandId === report.commandId &&
      assignment.turn.pending.participantId === participantId,
  );
  if (pendingEntry === undefined) {
    return { ...noEffects(), run: inputRun };
  }
  const [assignmentId, current] = pendingEntry;
  const participant = inputRun.participants.get(participantId)!;
  let run = inputRun;
  if (report.cooldownMs !== undefined && report.cooldownMs !== null) {
    run = setParticipant(run, {
      ...participant,
      readiness: {
        alive: participant.readiness?.alive ?? true,
        readyAt: now + report.cooldownMs,
        usable: participant.readiness?.usable ?? true,
      },
    });
  }

  if (report.outcome === "confirmed") {
    if (current.strategy.type === "focus") {
      // A confirmed cast is authoritative before aura projections converge,
      // preventing another participant from receiving a duplicate command.
      for (const currentParticipant of run.participants.values()) {
        const target = currentParticipant.targets.get(assignmentId);
        if (target === undefined) continue;
        run = setParticipant(run, {
          ...currentParticipant,
          targets: new Map(currentParticipant.targets).set(assignmentId, {
            ...target,
            focusActive: true,
          }),
        });
      }
    }
    const assignment: AssignmentState = {
      ...current,
      focusActive:
        current.strategy.type === "focus" ? true : current.focusActive,
      focusLossHandled:
        current.strategy.type === "focus" ? false : current.focusLossHandled,
      nextPlayerOffset: participant.playerNumber % inputRun.playerCount,
      turn: undefined,
    };
    run = setAssignment(run, assignment);
    return { ...noEffects(), run };
  }

  const assignment: AssignmentState = {
    ...current,
    turn: {
      ...current.turn!,
      hadFailure: report.outcome !== "skipped" || current.turn!.hadFailure,
      pending: undefined,
    },
  };
  run = setAssignment(run, assignment);
  return attemptAssignment(run, assignmentId, now);
};

export const applyReport = (
  run: RunState,
  participantId: ArmyParticipantId,
  report: ArmyLoopTauntReport,
  now: number,
): RunMutation | ArmyLoopTauntError => {
  if (run.status === "terminal") return { ...noEffects(), run };
  const participant = run.participants.get(participantId)!;
  switch (report.type) {
    case "participant-state":
      return applyParticipantState(run, participantId, report, now);
    case "target-state":
      return applyTargetState(run, participant, report, now);
    case "focus-state":
      return applyFocusState(run, participant, report, now);
    case "message":
      return applyMessage(run, participant, report, now);
    case "command-result":
      return applyCommandResult(run, participantId, report, now);
    case "failed":
      return terminalize(run, {
        reason: report.reason,
        status: "failed",
      });
  }
};
