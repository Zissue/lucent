import { makeListenerRegistry } from "../../app/ListenerRegistry";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  isReadinessCurrent,
  leaveRun,
  loopError,
  type MutationEffects,
  noEffects,
  onTimer as advanceTimer,
  registerRun,
  REGISTRATION_TIMEOUT_MS,
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
    const commandEvents = makeListenerRegistry<ArmyLoopTauntCommandEvent>();

    const currentCommand = (
      event: ArmyLoopTauntCommandEvent,
    ): Effect.Effect<ArmyLoopTauntCommandEvent | undefined> =>
      coordinator
        .loopTauntTimer(event.command.sessionId, (slot) => {
          const current = commandForPublication(slot, event);
          return {
            effects: {
              ...noEffects(),
              commands: current === undefined ? [] : [current],
            },
            result: Result.succeed(undefined),
            slot,
          };
        })
        .pipe(Effect.map((effects) => effects.commands[0]));

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
        const effects = yield* coordinator.loopTauntTimer(
          timer.sessionId,
          (slot, now) => advanceTimer(slot, timer, now),
        );
        yield* applyEffects(effects);
      }).pipe(Effect.uninterruptible);

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
            return coordinator
              .loopTauntTimer(readiness.sessionId, (slot) => ({
                effects: {
                  ...noEffects(),
                  readiness: isReadinessCurrent(slot, readiness)
                    ? [readiness]
                    : [],
                },
                result: Result.succeed(undefined),
                slot,
              }))
              .pipe(
                Effect.flatMap((current) =>
                  current.readiness.length === 0
                    ? Effect.void
                    : Deferred.succeed(readiness.gate, readiness.result).pipe(
                        Effect.asVoid,
                      ),
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
        const readinessGate = yield* Deferred.make<
          ArmyLoopTauntRegisterResult,
          ArmyLoopTauntError
        >();
        const terminalGate =
          yield* Deferred.make<ArmyLoopTauntTerminalResult>();
        const [result, effects] = yield* coordinator.loopTaunt(
          payload.sessionId,
          senderId,
          (slot, participant, now) =>
            registerRun(
              slot,
              payload,
              participant,
              { readinessGate, terminalGate },
              now,
            ),
        );
        yield* applyEffects(effects);
        return result;
      }).pipe(Effect.uninterruptible);

    const requireRun = (
      payload: ArmyLoopTauntRunPayload,
      senderId: ArmyParticipantId,
    ) =>
      coordinator
        .loopTaunt(payload.sessionId, senderId, (slot) => {
          const run = runForPayload(slot, payload, senderId);
          return {
            effects: noEffects(),
            result:
              run instanceof ArmyLoopTauntError
                ? Result.fail(run)
                : Result.succeed(run),
            slot,
          };
        })
        .pipe(Effect.map(([run]) => run));

    const ready: ArmyLoopTauntOrchestratorShape["ready"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        const run = yield* requireRun(payload, senderId);
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
        const run = yield* requireRun(payload, senderId);
        return yield* Deferred.await(run.terminalGate);
      });

    const report: ArmyLoopTauntOrchestratorShape["report"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        const [, effects] = yield* coordinator.loopTaunt(
          payload.sessionId,
          senderId,
          (slot, _, now) => reportRun(slot, payload, senderId, now),
        );
        yield* applyEffects(effects);
      }).pipe(Effect.uninterruptible);

    const leave: ArmyLoopTauntOrchestratorShape["leave"] = (
      payload,
      senderId,
    ) =>
      Effect.gen(function* () {
        const effects = yield* coordinator.loopTauntTimer(
          payload.sessionId,
          (slot, now) => leaveRun(slot, payload, senderId, now),
        );
        yield* applyEffects(effects);
      }).pipe(Effect.uninterruptible);

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
