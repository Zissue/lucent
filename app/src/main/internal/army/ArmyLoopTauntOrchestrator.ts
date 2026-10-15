import { makeListenerRegistry } from "../../app/ListenerRegistry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

import type {
  ArmyLoopTauntLeavePayload,
  ArmyLoopTauntRegisterPayload,
  ArmyLoopTauntRegisterResult,
  ArmyLoopTauntReportPayload,
  ArmyLoopTauntRunPayload,
  ArmyLoopTauntTerminalResult,
} from "@lucent/core/army";
import {
  ArmyCoordinator,
  type ArmyCoordinatorError,
  type ArmyParticipantId,
} from "./ArmyCoordinator";
import {
  ArmyLoopTauntError,
  type ArmyLoopTauntCommandEvent,
  COMMAND_CONFIRMATION_TIMEOUT_MS,
  commandForPublication,
  endLoopTaunt,
  initialLoopTauntSlot,
  isReadinessCurrent,
  leaveRun,
  type LoopTauntSlot,
  type LoopTauntStep,
  loopError,
  mergeMutationEffects,
  type MutationEffects,
  noEffects,
  onTimer as advanceTimer,
  registerRun,
  REGISTRATION_TIMEOUT_MS,
  rejectRegistration,
  reportRun,
  runForPayload,
  type ScheduledTimer,
} from "./ArmyLoopTauntState";

export type { ArmyLoopTauntCommandEvent } from "./ArmyLoopTauntState";

export type ArmyLoopTauntOrchestratorError =
  | ArmyCoordinatorError
  | ArmyLoopTauntError;

export interface ArmyLoopTauntOrchestratorShape {
  readonly await: (
    payload: ArmyLoopTauntRunPayload,
    senderId: ArmyParticipantId,
  ) => Effect.Effect<
    ArmyLoopTauntTerminalResult,
    ArmyLoopTauntOrchestratorError
  >;
  readonly leave: (
    payload: ArmyLoopTauntLeavePayload,
    senderId: ArmyParticipantId,
  ) => Effect.Effect<void, ArmyLoopTauntOrchestratorError>;
  readonly onCommand: (
    listener: (
      event: ArmyLoopTauntCommandEvent,
    ) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<() => void>;
  readonly register: (
    payload: ArmyLoopTauntRegisterPayload,
    senderId: ArmyParticipantId,
  ) => Effect.Effect<
    ArmyLoopTauntRegisterResult,
    ArmyLoopTauntOrchestratorError
  >;
  readonly ready: (
    payload: ArmyLoopTauntRunPayload,
    senderId: ArmyParticipantId,
  ) => Effect.Effect<void, ArmyLoopTauntOrchestratorError>;
  readonly report: (
    payload: ArmyLoopTauntReportPayload,
    senderId: ArmyParticipantId,
  ) => Effect.Effect<void, ArmyLoopTauntOrchestratorError>;
}

export class ArmyLoopTauntOrchestrator extends Context.Service<
  ArmyLoopTauntOrchestrator,
  ArmyLoopTauntOrchestratorShape
>()("lucent/internal/army/ArmyLoopTauntOrchestrator") {}

export const makeArmyLoopTauntOrchestrator = (): Effect.Effect<
  ArmyLoopTauntOrchestratorShape,
  never,
  ArmyCoordinator | Scope.Scope
> =>
  Effect.gen(function* () {
    const coordinator = yield* ArmyCoordinator;
    const scope = yield* Effect.scope;
    const stateRef = yield* Ref.make(new Map<string, LoopTauntSlot>());
    const commandEvents = makeListenerRegistry<ArmyLoopTauntCommandEvent>();

    const modifySlot = <A>(
      sessionId: string,
      step: (slot: LoopTauntSlot) => LoopTauntStep<A>,
    ) =>
      Ref.modify(stateRef, (state) => {
        const slot = state.get(sessionId) ?? initialLoopTauntSlot;
        const outcome = step(slot);
        return [
          outcome,
          outcome.slot === slot
            ? state
            : new Map(state).set(sessionId, outcome.slot),
        ] as const;
      });

    // State mutations publish effects after releasing stateRef. A newer report
    // or teardown can stale an effect before it crosses IPC.
    const currentCommand = (
      event: ArmyLoopTauntCommandEvent,
    ): Effect.Effect<ArmyLoopTauntCommandEvent | undefined> =>
      Ref.get(stateRef).pipe(
        Effect.map((state) =>
          commandForPublication(state.get(event.command.sessionId), event),
        ),
      );

    const publishCommands = (commands: readonly ArmyLoopTauntCommandEvent[]) =>
      Effect.forEach(
        commands,
        (command) =>
          currentCommand(command).pipe(
            Effect.flatMap((current) =>
              current === undefined
                ? Effect.void
                : commandEvents.publish(current),
            ),
          ),
        { discard: true },
      );

    const onTimer = (timer: ScheduledTimer) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const outcome = yield* modifySlot(timer.sessionId, (slot) =>
          advanceTimer(slot, timer, now),
        );
        yield* applyEffects(outcome.effects);
      });

    const scheduleTimer = (timer: ScheduledTimer) => {
      let delayMs: number;
      switch (timer.type) {
        case "command-timeout":
          delayMs = COMMAND_CONFIRMATION_TIMEOUT_MS;
          break;
        case "registration-timeout":
          delayMs = REGISTRATION_TIMEOUT_MS;
          break;
        default:
          delayMs = timer.delayMs;
      }
      return Effect.sleep(`${delayMs} millis`).pipe(
        Effect.andThen(onTimer(timer)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    };

    const applyEffects = (effects: MutationEffects): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          effects.terminals,
          ({ gate, result }) =>
            Deferred.succeed(gate, result).pipe(Effect.asVoid),
          { concurrency: "unbounded", discard: true },
        );
        yield* Effect.forEach(
          effects.readiness,
          (readiness) => {
            if (readiness.type === "fail") {
              return Deferred.fail(readiness.gate, readiness.error).pipe(
                Effect.asVoid,
              );
            }
            return Ref.get(stateRef).pipe(
              Effect.flatMap((state) =>
                isReadinessCurrent(state.get(readiness.sessionId), readiness)
                  ? Deferred.succeed(readiness.gate, readiness.result).pipe(
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
            );
          },
          { concurrency: "unbounded", discard: true },
        );
        yield* Effect.forEach(effects.timers, scheduleTimer, {
          discard: true,
        });
        yield* publishCommands(effects.commands);
      });

    const register: ArmyLoopTauntOrchestratorShape["register"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        const identity = yield* coordinator.requireParticipant(
          payload.sessionId,
          senderId,
        );
        const now = yield* Clock.currentTimeMillis;
        const readinessGate = yield* Deferred.make<
          ArmyLoopTauntRegisterResult,
          ArmyLoopTauntError
        >();
        const terminalGate =
          yield* Deferred.make<ArmyLoopTauntTerminalResult>();
        const outcome = yield* modifySlot(payload.sessionId, (slot) =>
          registerRun(
            slot,
            payload,
            { ...identity, id: senderId },
            { readinessGate, terminalGate },
            now,
          ),
        );
        if (Result.isFailure(outcome.result))
          return yield* outcome.result.failure;
        const result = outcome.result.success;
        // Coordinator teardown and orchestrator registration commit under
        // separate locks, so authenticate again before publishing activation.
        const reauthenticated = yield* coordinator
          .requireParticipant(payload.sessionId, senderId)
          .pipe(Effect.result);
        if (Result.isFailure(reauthenticated)) {
          const cleanup = yield* modifySlot(payload.sessionId, (slot) =>
            rejectRegistration(slot, result.runId, senderId),
          );
          yield* applyEffects(
            mergeMutationEffects(outcome.effects, cleanup.effects),
          );
          return yield* reauthenticated.failure;
        }
        yield* applyEffects(outcome.effects);
        return result;
      });

    const ready: ArmyLoopTauntOrchestratorShape["ready"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        yield* coordinator.requireParticipant(payload.sessionId, senderId);
        const run = yield* Ref.get(stateRef).pipe(
          Effect.map((state) =>
            runForPayload(state.get(payload.sessionId), payload, senderId),
          ),
        );
        if (run instanceof ArmyLoopTauntError) return yield* run;
        if (run.status === "terminal") {
          return yield* loopError(
            "registration-failed",
            run.terminal?.status === "failed"
              ? run.terminal.reason
              : "Loop taunt registration was superseded",
            run.sessionId,
            run.runId,
          );
        }
        yield* Deferred.await(run.readinessGate);
      });

    const awaitRun: ArmyLoopTauntOrchestratorShape["await"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        yield* coordinator.requireParticipant(payload.sessionId, senderId);
        const run = yield* Ref.get(stateRef).pipe(
          Effect.map((state) =>
            runForPayload(state.get(payload.sessionId), payload, senderId),
          ),
        );
        if (run instanceof ArmyLoopTauntError) return yield* run;
        return yield* Deferred.await(run.terminalGate);
      });

    const report: ArmyLoopTauntOrchestratorShape["report"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        yield* coordinator.requireParticipant(payload.sessionId, senderId);
        const now = yield* Clock.currentTimeMillis;
        const outcome = yield* modifySlot(payload.sessionId, (slot) =>
          reportRun(slot, payload, senderId, now),
        );
        if (Result.isFailure(outcome.result))
          return yield* outcome.result.failure;
        yield* applyEffects(outcome.effects);
      });

    const leave: ArmyLoopTauntOrchestratorShape["leave"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const outcome = yield* modifySlot(payload.sessionId, (slot) =>
          leaveRun(slot, payload, senderId, now),
        );
        yield* applyEffects(outcome.effects);
      });

    const endSession = (
      sessionId: string,
      reason: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const effects = yield* Ref.modify(stateRef, (state) => {
          const slot = state.get(sessionId);
          if (slot === undefined) return [noEffects(), state] as const;
          const next = new Map(state);
          next.delete(sessionId);
          return [endLoopTaunt(slot, reason), next] as const;
        });
        yield* applyEffects(effects);
      });

    const unsubscribe = yield* coordinator.onSessionEnded((event) =>
      endSession(event.sessionId, event.reason),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        unsubscribe();
        const state = yield* Ref.get(stateRef);
        for (const sessionId of state.keys()) {
          yield* endSession(sessionId, "Application is quitting");
        }
      }),
    );

    return ArmyLoopTauntOrchestrator.of({
      await: awaitRun,
      leave,
      onCommand: commandEvents.subscribe,
      ready,
      register,
      report,
    });
  });

export const layer = Layer.effect(
  ArmyLoopTauntOrchestrator,
  makeArmyLoopTauntOrchestrator(),
);
