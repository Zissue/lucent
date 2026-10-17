import type {
  ArmyLoopTauntCommand,
  ArmyLoopTauntCommandPayload,
  ArmyLoopTauntResolvedTarget,
  ArmyLoopTauntTerminalResult,
} from "@lucent/core/army";
import {
  type ArmyLoopTauntCommandEvent,
  type ArmyLoopTauntError,
  type ArmyParticipantId,
  type AssignmentState,
  COMMAND_CONFIRMATION_TIMEOUT_MS,
  DEGRADED_AFTER_SWEEPS,
  DEGRADED_TIMEOUT_MS,
  DEGRADED_WARNING_MS,
  type DegradedState,
  loopError,
  type LoopTauntSlot,
  mergeMutationEffects,
  type MutationEffects,
  noEffects,
  type ReadinessEffect,
  type RunMutation,
  type RunParticipant,
  type RunState,
  type ScheduledTimer,
  SWEEP_RETRY_MS,
} from "./ArmyLoopTauntModel";

export const setAssignment = (
  run: RunState,
  assignment: AssignmentState,
): RunState => ({
  ...run,
  assignments: new Map(run.assignments).set(
    assignment.assignmentId,
    assignment,
  ),
});

export const setParticipant = (
  run: RunState,
  participant: RunParticipant,
): RunState => ({
  ...run,
  participants: new Map(run.participants).set(participant.id, participant),
});

export const priorityDecision = (
  run: RunState,
): {
  readonly selectedGroupIndex?: number | undefined;
  readonly unresolvedAssignmentIds: ReadonlySet<number>;
} => {
  // Every renderer must agree that a higher-priority group is dead before
  // lower-priority assignments may issue casts.
  for (const [groupIndex, assignmentIds] of run.priorityGroups.entries()) {
    const unresolvedAssignmentIds = assignmentIds.filter(
      (assignmentId) =>
        run.assignments.get(assignmentId)!.targetState === "unresolved",
    );
    if (
      assignmentIds.some(
        (assignmentId) =>
          run.assignments.get(assignmentId)!.targetState === "alive",
      )
    ) {
      return {
        selectedGroupIndex: groupIndex,
        unresolvedAssignmentIds: new Set(unresolvedAssignmentIds),
      };
    }
    if (unresolvedAssignmentIds.length > 0) {
      return {
        unresolvedAssignmentIds: new Set(unresolvedAssignmentIds),
      };
    }
  }
  return { unresolvedAssignmentIds: new Set() };
};

export const refreshPriorityGroup = (run: RunState): RunState => {
  const { selectedGroupIndex } = priorityDecision(run);
  const activeAssignmentIds =
    selectedGroupIndex === undefined
      ? new Set<number>()
      : new Set(run.priorityGroups[selectedGroupIndex]);
  const assignments = new Map<number, AssignmentState>();

  for (const [assignmentId, assignment] of run.assignments) {
    const active =
      activeAssignmentIds.has(assignmentId) &&
      assignment.targetState === "alive";
    if (active === assignment.active) {
      assignments.set(assignmentId, assignment);
      continue;
    }
    let updated: AssignmentState = {
      ...assignment,
      active,
      focusLossHandled: active ? false : assignment.focusLossHandled,
      turn: undefined,
    };
    const pendingMessage = updated.pendingMessage;
    if (
      active &&
      updated.strategy.type === "message" &&
      pendingMessage !== undefined &&
      pendingMessage.monsterMapId === updated.monsterMapId &&
      pendingMessage.lifeRevision === updated.lifeRevision
    ) {
      updated = startTurn({
        ...updated,
        lastMessageAt: pendingMessage.observedAt,
        pendingMessage: undefined,
      });
    }
    assignments.set(assignmentId, updated);
  }

  return { ...run, assignments };
};

export const issueCommand = (
  run: RunState,
  participantIds: readonly ArmyParticipantId[],
  command: ArmyLoopTauntCommand,
): readonly [RunState, ArmyLoopTauntCommandEvent] => {
  const payload: ArmyLoopTauntCommandPayload = {
    command,
    commandId: run.nextCommandId,
    runId: run.runId,
    sessionId: run.sessionId,
  };
  return [
    { ...run, nextCommandId: run.nextCommandId + 1 },
    { command: payload, participantIds },
  ];
};

export const assignmentRing = (
  run: RunState,
  assignment: AssignmentState,
): readonly RunParticipant[] => {
  const assigned = new Set(assignment.players);
  return [...run.participants.values()]
    .filter((participant) => assigned.has(participant.playerNumber))
    .toSorted((left, right) => left.playerNumber - right.playerNumber);
};

const orderedFromCursor = (
  run: RunState,
  assignment: AssignmentState,
  ring: readonly RunParticipant[],
): readonly RunParticipant[] =>
  ring.toSorted((left, right) => {
    const leftOffset =
      (left.playerNumber - 1 - assignment.nextPlayerOffset + run.playerCount) %
      run.playerCount;
    const rightOffset =
      (right.playerNumber - 1 - assignment.nextPlayerOffset + run.playerCount) %
      run.playerCount;
    return leftOffset - rightOffset;
  });

export const isReady = (participant: RunParticipant, now: number): boolean =>
  participant.readiness?.alive === true &&
  participant.readiness.usable &&
  participant.readiness.readyAt <= now;

export const startTurn = (assignment: AssignmentState): AssignmentState => {
  if (!assignment.active || assignment.turn !== undefined) return assignment;
  return {
    ...assignment,
    nextTurnId: assignment.nextTurnId + 1,
    turn: {
      attempted: new Set(),
      failedSweeps: 0,
      hadFailure: false,
      id: assignment.nextTurnId,
    },
  };
};

const recoverAssignment = (assignment: AssignmentState): AssignmentState => {
  const turn = assignment.turn;
  if (turn === undefined) {
    return { ...assignment, degraded: undefined };
  }

  const awaitingResult = turn.pending !== undefined;
  return {
    ...assignment,
    degraded: undefined,
    turn: {
      ...turn,
      attempted: awaitingResult ? turn.attempted : new Set(),
      failedSweeps: 0,
      hadFailure: awaitingResult && turn.hadFailure,
    },
  };
};

export const attemptAssignment = (
  inputRun: RunState,
  assignmentId: number,
  now: number,
): RunMutation => {
  const effects = noEffects();
  const assignment = inputRun.assignments.get(assignmentId);
  if (
    inputRun.status !== "active" ||
    assignment === undefined ||
    !assignment.active ||
    assignment.turn === undefined ||
    assignment.turn.pending !== undefined
  ) {
    return { ...effects, run: inputRun };
  }
  const turn = assignment.turn;

  const ring = orderedFromCursor(
    inputRun,
    assignment,
    assignmentRing(inputRun, assignment),
  );
  const hasInitialReadiness = ring.every(
    (participant) => participant.readiness !== undefined,
  );
  const participant = hasInitialReadiness
    ? ring.find(
        (candidate) =>
          !turn.attempted.has(candidate.id) && isReady(candidate, now),
      )
    : undefined;

  if (participant !== undefined) {
    const target = participant.targets.get(assignmentId);
    if (target === undefined) return { ...effects, run: inputRun };
    const [commandRun, command] = issueCommand(inputRun, [participant.id], {
      assignmentId,
      expiresAt: now + COMMAND_CONFIRMATION_TIMEOUT_MS,
      lifeRevision: assignment.lifeRevision,
      monsterMapId: target.monsterMapId,
      type: "taunt",
    });
    const updatedAssignment: AssignmentState = {
      ...assignment,
      turn: {
        ...turn,
        attempted: new Set(turn.attempted).add(participant.id),
        pending: {
          commandId: command.command.commandId,
          participantId: participant.id,
        },
      },
    };
    return {
      commands: [command],
      readiness: [],
      run: setAssignment(commandRun, updatedAssignment),
      terminals: [],
      timers: [
        {
          assignmentId,
          commandId: command.command.commandId,
          runId: inputRun.runId,
          sessionId: inputRun.sessionId,
          type: "command-timeout",
        },
      ],
    };
  }

  const cooling = hasInitialReadiness
    ? ring.filter(
        (candidate) =>
          candidate.readiness?.alive === true &&
          candidate.readiness.usable &&
          candidate.readiness.readyAt > now,
      )
    : [];
  if (cooling.length > 0) {
    const readyAt = Math.min(
      ...cooling.map((candidate) => candidate.readiness!.readyAt),
    );
    const coolingIds = new Set(cooling.map((candidate) => candidate.id));
    const updatedAssignment: AssignmentState = {
      ...assignment,
      turn: {
        ...turn,
        attempted: new Set(
          [...turn.attempted].filter(
            (participantId) => !coolingIds.has(participantId),
          ),
        ),
      },
    };
    return {
      commands: [],
      readiness: [],
      run: setAssignment(inputRun, updatedAssignment),
      terminals: [],
      timers: [
        {
          assignmentId,
          delayMs: Math.max(1, readyAt - now),
          failedSweeps: turn.failedSweeps,
          runId: inputRun.runId,
          sessionId: inputRun.sessionId,
          turnId: turn.id,
          type: "retry",
        },
      ],
    };
  }

  const failedSweeps = turn.failedSweeps + 1;
  const allSkipped =
    ring.length > 0 && turn.attempted.size === ring.length && !turn.hadFailure;
  if (allSkipped) {
    const updatedAssignment: AssignmentState = {
      ...assignment,
      degraded: undefined,
      turn: {
        ...turn,
        attempted: new Set(),
        failedSweeps: 0,
        hadFailure: false,
        pending: undefined,
      },
    };
    return {
      commands: [],
      readiness: [],
      run: setAssignment(inputRun, updatedAssignment),
      terminals: [],
      timers: [
        {
          assignmentId,
          delayMs: SWEEP_RETRY_MS,
          failedSweeps: 0,
          runId: inputRun.runId,
          sessionId: inputRun.sessionId,
          turnId: turn.id,
          type: "retry",
        },
      ],
    };
  }

  const enteringDegraded =
    failedSweeps >= DEGRADED_AFTER_SWEEPS && assignment.degraded === undefined;
  const degradationRevision = enteringDegraded
    ? assignment.degradationRevision + 1
    : assignment.degradationRevision;
  const degraded: DegradedState | undefined = enteringDegraded
    ? {
        accumulatedMs: 0,
        activeSince: now,
        reason: "readiness",
        revision: degradationRevision,
      }
    : assignment.degraded;
  const updatedAssignment: AssignmentState = {
    ...assignment,
    degradationRevision,
    degraded,
    turn: {
      ...turn,
      attempted: new Set(),
      failedSweeps,
      hadFailure: false,
      pending: undefined,
    },
  };
  let run = setAssignment(inputRun, updatedAssignment);
  const commands: ArmyLoopTauntCommandEvent[] = [];

  if (enteringDegraded) {
    const issued = issueCommand(run, [...run.participants.keys()], {
      assignmentId,
      code: "degraded",
      level: "warning",
      message: `Loop taunt is degraded for assignment ${assignmentId}`,
      type: "diagnostic",
    });
    run = issued[0];
    commands.push(issued[1]);
  }

  const probeIds =
    ring.length === 0
      ? [...run.participants.keys()]
      : ring.map((candidate) => candidate.id);
  if (probeIds.length > 0) {
    const issued = issueCommand(run, probeIds, { type: "probe" });
    run = issued[0];
    commands.push(issued[1]);
  }

  const timers: ScheduledTimer[] = [
    {
      assignmentId,
      delayMs: SWEEP_RETRY_MS,
      failedSweeps,
      runId: run.runId,
      sessionId: run.sessionId,
      turnId: turn.id,
      type: "retry",
    },
  ];
  if (enteringDegraded) {
    timers.push({
      assignmentId,
      delayMs: DEGRADED_TIMEOUT_MS,
      revision: degraded!.revision,
      runId: run.runId,
      sessionId: run.sessionId,
      type: "degraded-timeout",
    });
  }
  return { commands, readiness: [], run, terminals: [], timers };
};

export const refreshAssignmentFromTargets = (
  run: RunState,
  assignmentId: number,
): RunState => {
  const current = run.assignments.get(assignmentId);
  if (current === undefined) return run;
  const targets = [...run.participants.values()]
    .map((participant) => participant.targets.get(assignmentId))
    .filter(
      (target): target is ArmyLoopTauntResolvedTarget => target !== undefined,
    );
  const candidate = targets[0];
  const hasIdentityConsensus =
    candidate !== undefined &&
    targets.length === run.participants.size &&
    targets.every(
      (target) =>
        target.monsterMapId === candidate.monsterMapId &&
        target.lifeRevision === candidate.lifeRevision,
    );
  let targetState: AssignmentState["targetState"] = "unresolved";
  if (
    hasIdentityConsensus &&
    candidate !== undefined &&
    targets.every((target) => target.state === candidate.state)
  ) {
    targetState = candidate.state;
  }
  const alive = targetState === "alive";
  // One positive Focus observation suppresses another cast while projections
  // converge; duplicate taunts are more dangerous than a brief delay.
  const focusActive = alive && targets.some((target) => target.focusActive);
  const canonicalChanged =
    hasIdentityConsensus &&
    (candidate.monsterMapId !== current.monsterMapId ||
      candidate.lifeRevision !== current.lifeRevision);
  const observedLifeRevision = targets.reduce(
    (revision, target) => Math.max(revision, target.lifeRevision),
    current.lifeRevision,
  );
  const observedNewLife = targets.some(
    (target) =>
      target.lifeRevision > current.lifeRevision ||
      (current.targetState === "dead" &&
        target.monsterMapId === current.monsterMapId &&
        target.lifeRevision === current.lifeRevision &&
        target.state === "alive"),
  );
  const resetRevision = hasIdentityConsensus
    ? candidate.lifeRevision
    : observedLifeRevision;
  // Reset on the first new-life observation so delayed consensus cannot carry
  // the previous life's rotation into a respawn.
  const resetLife =
    (canonicalChanged || observedNewLife) &&
    current.pendingLifeRevision !== resetRevision;
  const aliveChanged = alive !== (current.targetState === "alive");
  let assignment: AssignmentState = {
    ...current,
    degraded: resetLife ? undefined : current.degraded,
    focusActive,
    focusLossHandled:
      aliveChanged || resetLife ? false : current.focusLossHandled,
    lastMessageAt: resetLife ? undefined : current.lastMessageAt,
    lifeRevision: hasIdentityConsensus
      ? candidate.lifeRevision
      : current.lifeRevision,
    monsterMapId: hasIdentityConsensus
      ? candidate.monsterMapId
      : current.monsterMapId,
    nextPlayerOffset: resetLife ? 0 : current.nextPlayerOffset,
    pendingLifeRevision: hasIdentityConsensus
      ? undefined
      : observedNewLife
        ? resetRevision
        : current.pendingLifeRevision,
    pendingMessage: resetLife ? undefined : current.pendingMessage,
    targetState,
    turn: !alive || resetLife ? undefined : current.turn,
  };
  if (
    assignment.strategy.type === "message" &&
    assignment.pendingMessage !== undefined &&
    hasIdentityConsensus
  ) {
    const pendingMatches =
      alive &&
      assignment.pendingMessage.monsterMapId === candidate.monsterMapId &&
      assignment.pendingMessage.lifeRevision === candidate.lifeRevision;
    if (!pendingMatches) {
      assignment = {
        ...assignment,
        pendingMessage: undefined,
      };
    }
  }
  if (
    assignment.strategy.type === "focus" &&
    assignment.active &&
    alive &&
    focusActive
  ) {
    assignment = {
      ...recoverAssignment(assignment),
      turn: undefined,
    };
  }
  return setAssignment(run, assignment);
};

export const refreshAllAssignments = (inputRun: RunState): RunState => {
  let run = inputRun;
  for (const assignmentId of run.assignments.keys()) {
    run = refreshAssignmentFromTargets(run, assignmentId);
  }
  return refreshPriorityGroup(run);
};

const reconcileTopology = (inputRun: RunState, now: number): RunMutation => {
  let run = inputRun;
  let effects: MutationEffects = noEffects();
  const { unresolvedAssignmentIds } = priorityDecision(run);

  for (const assignmentId of run.assignments.keys()) {
    let assignment = run.assignments.get(assignmentId)!;
    const ring = assignmentRing(run, assignment);

    if (unresolvedAssignmentIds.has(assignmentId)) {
      const enteringDegraded =
        assignment.degraded?.reason !== "target-consensus";
      const degradationRevision = enteringDegraded
        ? assignment.degradationRevision + 1
        : assignment.degradationRevision;
      assignment = {
        ...assignment,
        degradationRevision,
        degraded: enteringDegraded
          ? {
              accumulatedMs: 0,
              activeSince: now,
              reason: "target-consensus",
              revision: degradationRevision,
            }
          : assignment.degraded,
        turn: undefined,
      };
      run = setAssignment(run, assignment);
      if (enteringDegraded) {
        effects = mergeMutationEffects(effects, {
          commands: [],
          readiness: [],
          terminals: [],
          timers: [
            {
              assignmentId,
              delayMs: DEGRADED_WARNING_MS,
              revision: degradationRevision,
              runId: run.runId,
              sessionId: run.sessionId,
              type: "degraded-warning",
            },
            {
              assignmentId,
              delayMs: DEGRADED_TIMEOUT_MS,
              revision: degradationRevision,
              runId: run.runId,
              sessionId: run.sessionId,
              type: "degraded-timeout",
            },
          ],
        });
      }
      continue;
    }

    if (assignment.degraded?.reason === "target-consensus") {
      assignment = { ...assignment, degraded: undefined };
    }

    if (
      assignment.active &&
      ring.length === 0 &&
      assignment.turn === undefined
    ) {
      assignment = startTurn(assignment);
    }
    if (
      assignment.active &&
      assignment.strategy.type === "focus" &&
      !assignment.focusActive &&
      !assignment.focusLossHandled &&
      assignment.turn === undefined
    ) {
      assignment = {
        ...startTurn(assignment),
        focusLossHandled: true,
      };
    }

    const turn = assignment.turn;
    if (!assignment.active || turn === undefined) {
      // Preemption and active Focus pause degradation; time without a required
      // taunt must not consume the assignment's recovery budget.
      let degraded = assignment.degraded;
      let degradationRevision = assignment.degradationRevision;
      if (degraded?.activeSince !== undefined) {
        degradationRevision += 1;
        degraded = {
          accumulatedMs:
            degraded.accumulatedMs + Math.max(0, now - degraded.activeSince),
          reason: degraded.reason,
          revision: degradationRevision,
        };
      }
      assignment = {
        ...assignment,
        degradationRevision,
        degraded,
        turn: undefined,
      };
      run = setAssignment(run, assignment);
      continue;
    }

    if (
      assignment.degraded !== undefined &&
      assignment.degraded.activeSince === undefined
    ) {
      const degradationRevision = assignment.degradationRevision + 1;
      const degraded: DegradedState = {
        ...assignment.degraded,
        activeSince: now,
        revision: degradationRevision,
      };
      assignment = { ...assignment, degradationRevision, degraded };
      effects = mergeMutationEffects(effects, {
        commands: [],
        readiness: [],
        terminals: [],
        timers: [
          {
            assignmentId,
            delayMs: Math.max(0, DEGRADED_TIMEOUT_MS - degraded.accumulatedMs),
            revision: degraded.revision,
            runId: run.runId,
            sessionId: run.sessionId,
            type: "degraded-timeout",
          },
        ],
      });
    }

    const pendingParticipantId = turn.pending?.participantId;
    if (
      pendingParticipantId !== undefined &&
      !ring.some((participant) => participant.id === pendingParticipantId)
    ) {
      const attempted = new Set(turn.attempted);
      attempted.delete(pendingParticipantId);
      assignment = {
        ...assignment,
        turn: {
          ...turn,
          attempted,
          hadFailure: true,
          pending: undefined,
        },
      };
    }

    run = setAssignment(run, assignment);
    const attempted = attemptAssignment(run, assignmentId, now);
    run = attempted.run;
    effects = mergeMutationEffects(effects, attempted);
  }

  return { ...effects, run };
};

const normalizeMessage = (message: string): string =>
  message.trim().replaceAll(/\s+/g, " ").toLocaleLowerCase();

export const matchesMessage = (actual: string, configured: string): boolean => {
  const expected = normalizeMessage(configured);
  return expected !== "" && normalizeMessage(actual).includes(expected);
};

export const terminalReadinessError = (
  run: Pick<RunState, "sessionId" | "runId">,
  result: ArmyLoopTauntTerminalResult | undefined,
): ArmyLoopTauntError =>
  loopError(
    "registration-failed",
    result?.status === "failed"
      ? result.reason
      : "Loop taunt registration was superseded",
    run.sessionId,
    run.runId,
  );

interface RunGateSettlement {
  readonly readiness: Extract<ReadinessEffect, { readonly type: "fail" }>;
  readonly terminal: MutationEffects["terminals"][number];
}

const runGateSettlement = (
  run: RunState,
  result: ArmyLoopTauntTerminalResult,
): RunGateSettlement => ({
  readiness: {
    error: terminalReadinessError(run, result),
    gate: run.readinessGate,
    type: "fail",
  },
  terminal: { gate: run.terminalGate, result },
});

export const endLoopTaunt = (
  slot: LoopTauntSlot,
  reason: string,
): readonly RunGateSettlement[] =>
  [...slot.runs.values()].map((run) =>
    runGateSettlement(run, run.terminal ?? { reason, status: "failed" }),
  );

export const terminalize = (
  run: RunState,
  result: ArmyLoopTauntTerminalResult,
): RunMutation => {
  if (run.status === "terminal") {
    return { ...noEffects(), run };
  }
  const assignments = new Map(
    [...run.assignments].map(([assignmentId, assignment]) => [
      assignmentId,
      { ...assignment, turn: undefined },
    ]),
  );
  const settlement = runGateSettlement(run, result);
  return {
    commands: [],
    readiness: [settlement.readiness],
    run: {
      ...run,
      assignments,
      status: "terminal",
      terminal: result,
    },
    terminals: [settlement.terminal],
    timers: [],
  };
};

export const activateRun = (inputRun: RunState, now: number): RunMutation => {
  let run = refreshAllAssignments({ ...inputRun, status: "active" });
  let effects: MutationEffects = {
    ...noEffects(),
    readiness: [
      {
        gate: run.readinessGate,
        result: { runId: run.runId },
        sessionId: run.sessionId,
        type: "succeed",
      },
    ],
  };

  const participantIds = [...run.participants.keys()];
  if (participantIds.length > 0) {
    const issued = issueCommand(run, participantIds, { type: "probe" });
    run = issued[0];
    effects = mergeMutationEffects(effects, {
      commands: [issued[1]],
      readiness: [],
      terminals: [],
      timers: [],
    });
  }

  const reconciled = reconcileTopology(run, now);
  return {
    ...mergeMutationEffects(effects, reconciled),
    run: reconciled.run,
  };
};

export { reconcileTopology, recoverAssignment };
