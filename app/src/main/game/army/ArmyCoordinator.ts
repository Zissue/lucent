import { makeListenerRegistry } from "../../app/ListenerRegistry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";

import {
  normalizeArmyPlayerKey,
  type ArmyConfigPayload,
  type ArmyProgressResult,
  type ArmySessionPayload,
} from "@lucent/core/army";

import {
  type ArmyLoopTauntError,
  endLoopTaunt,
  type LoopTauntSlot,
  type LoopTauntStep,
  type MutationEffects,
  noEffects,
} from "./ArmyLoopTauntState";

import {
  ARMY_START_TIMEOUT_MS,
  ArmyParticipantError,
  type ArmyCoordinatorError,
  type ArmyParticipantId,
  type ArmyParticipant,
  type ArmySessionEndCause,
  type ArmySessionEndedEvent,
  type ArmyAuthenticatedParticipant,
  type StepSignature,
  type ArmySessionState,
  type ArmySessionSnapshot,
  type ArmyCoordinatorState,
  initialCoordinatorState,
  type ArmyCoordinatorEffect,
  type ArmyTransition,
  normalizeTimeout,
  normalizeLabel,
  sessionError,
  canonicalPlayerName,
  playerNumber,
  playersWhere,
  toPayload,
  checkpointName,
  unchanged,
  withSession,
  endSession,
  endParticipantSession,
  leaveSession,
  joinSession,
  expireStart,
  identify,
  arriveAtStep,
  expireStep,
  failSession,
} from "./ArmySession";

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
      ? Effect.logDebug("Army session ended")
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
  readonly getSessions: () => Effect.Effect<readonly ArmySessionSnapshot[]>;
  readonly getLoopTauntSlot: (
    sessionId: string,
  ) => Effect.Effect<LoopTauntSlot | undefined>;
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
  readonly loopTaunt: <A>(
    sessionId: string,
    participantId: ArmyParticipantId,
    step: (
      slot: LoopTauntSlot,
      seat: ArmyAuthenticatedParticipant & { readonly id: ArmyParticipantId },
      nowMs: number,
    ) => LoopTauntStep<A>,
  ) => Effect.Effect<
    readonly [A, MutationEffects],
    ArmyCoordinatorError | ArmyLoopTauntError
  >;
  readonly updateLoopTaunt: (
    sessionId: string,
    step: (slot: LoopTauntSlot, nowMs: number) => LoopTauntStep<void>,
  ) => Effect.Effect<MutationEffects>;
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
>()("lucent/desktop/game/army/ArmyCoordinator") {}

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
            Effect.logDebug("Army session started").pipe(
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
        if (session.phase === "active") {
          yield* Effect.forEach(
            endLoopTaunt(session.loopTaunt, cause.reason),
            ({ readiness, terminal }) =>
              Deferred.fail(readiness.gate, readiness.error).pipe(
                Effect.andThen(
                  Deferred.succeed(terminal.gate, terminal.result),
                ),
              ),
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

    const loopTaunt: ArmyCoordinatorShape["loopTaunt"] = <A>(
      sessionId: string,
      participantId: ArmyParticipantId,
      step: (
        slot: LoopTauntSlot,
        seat: ArmyAuthenticatedParticipant & { readonly id: ArmyParticipantId },
        nowMs: number,
      ) => LoopTauntStep<A>,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const result = yield* Ref.modify(
          stateRef,
          (
            state,
          ): readonly [
            Result.Result<
              readonly [A, MutationEffects],
              ArmyCoordinatorError | ArmyLoopTauntError
            >,
            ArmyCoordinatorState,
          ] => {
            const seat = identify(state, sessionId, participantId);
            if (Result.isFailure(seat))
              return [Result.fail(seat.failure), state];
            const { playerKey, session } = seat.success;
            const outcome = step(
              session.loopTaunt,
              {
                id: participantId,
                playerCount: session.config.players.length,
                playerName: canonicalPlayerName(session.config, playerKey),
                playerNumber: playerNumber(session.config, playerKey),
                sessionId,
              },
              nowMs,
            );
            return [
              Result.map(
                outcome.result,
                (result) => [result, outcome.effects] as const,
              ),
              outcome.slot === session.loopTaunt
                ? state
                : withSession(state, { ...session, loopTaunt: outcome.slot }),
            ] as const;
          },
        );
        return yield* Effect.fromResult(result);
      });

    const updateLoopTaunt: ArmyCoordinatorShape["updateLoopTaunt"] = (
      sessionId,
      step,
    ) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return yield* Ref.modify(stateRef, (state) => {
          const session = state.sessions.get(sessionId);
          if (session?.phase !== "active") return [noEffects(), state] as const;
          const outcome = step(session.loopTaunt, nowMs);
          return [
            outcome.effects,
            outcome.slot === session.loopTaunt
              ? state
              : withSession(state, { ...session, loopTaunt: outcome.slot }),
          ] as const;
        });
      });

    const getLoopTauntSlot: ArmyCoordinatorShape["getLoopTauntSlot"] = (
      sessionId,
    ) =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const session = state.sessions.get(sessionId);
          return session?.phase === "active" ? session.loopTaunt : undefined;
        }),
      );

    const abortSession: ArmyCoordinatorShape["abortSession"] = (
      sessionId,
      cause,
    ) => dispatch((state, nowMs) => endSession(state, sessionId, cause, nowMs));

    const getSessions: ArmyCoordinatorShape["getSessions"] = () =>
      Ref.get(stateRef).pipe(
        Effect.map((state) =>
          [...state.sessions.values()].map((session) => {
            if (session.phase === "collecting") return session;
            const { loopTaunt: _, ...snapshot } = session;
            return snapshot;
          }),
        ),
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
      getLoopTauntSlot,
      getSessions,
      join,
      leave: (participantId) =>
        dispatch((state, nowMs) => leaveSession(state, participantId, nowMs)),
      onSessionEnded: sessionEndedEvents.subscribe,
      progress,
      loopTaunt,
      updateLoopTaunt,
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
