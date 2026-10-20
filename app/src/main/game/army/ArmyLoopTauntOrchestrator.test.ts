import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type {
  ArmyConfigPayload,
  ArmyLoopTauntRegisterPayload,
  ArmyLoopTauntRegistrationAssignment,
  ArmyLoopTauntReport,
} from "@lucent/core/army";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import { ArmyCoordinator, makeArmyCoordinator } from "./ArmyCoordinator";
import type { ArmyCoordinatorError } from "./ArmySession";
import type { ArmyLoopTauntCommandEvent } from "./ArmyLoopTauntModel";
import {
  type ArmyLoopTauntOrchestratorShape,
  makeArmyLoopTauntOrchestrator,
} from "./ArmyLoopTauntOrchestrator";

let nextParticipantId = 10_000;

const makeConfig = (players: readonly string[]): ArmyConfigPayload => ({
  configName: `loop-taunt-${nextParticipantId}`,
  items: {},
  players,
  raw: { players, room: "1234" },
  room: 1234,
  sets: {},
});

interface Harness {
  readonly coordinator: ArmyCoordinator["Service"];
  readonly events: ArmyLoopTauntCommandEvent[];
  readonly ids: readonly number[];
  readonly orchestrator: ArmyLoopTauntOrchestratorShape;
  readonly sessionId: string;
}

const makeHarness = Effect.fn("ArmyLoopTauntOrchestrator.test.makeHarness")(
  function* (
    players: readonly string[],
    wrapCoordinator: (
      coordinator: ArmyCoordinator["Service"],
      ids: readonly number[],
    ) => ArmyCoordinator["Service"] = (coordinator) => coordinator,
    beforeOrchestrator: (
      coordinator: ArmyCoordinator["Service"],
    ) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
  ): Effect.fn.Return<Harness, ArmyCoordinatorError, Scope.Scope> {
    const coordinator = yield* makeArmyCoordinator();
    const ids = players.map(() => nextParticipantId++);
    const config = makeConfig(players);
    const sessions = yield* Effect.all(
      players.map((playerName, index) =>
        coordinator.join(config, playerName, {
          rendererId: ids[index]!,
          isCurrent: () => true,
        }),
      ),
      { concurrency: "unbounded" },
    );
    yield* beforeOrchestrator(coordinator);
    const orchestrator = yield* makeArmyLoopTauntOrchestrator().pipe(
      Effect.provideService(ArmyCoordinator, wrapCoordinator(coordinator, ids)),
    );
    const events: ArmyLoopTauntCommandEvent[] = [];
    yield* orchestrator.onCommand((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    return {
      coordinator,
      events,
      ids,
      orchestrator,
      sessionId: sessions[0]!.sessionId,
    };
  },
);

const assignment = (
  options: Partial<ArmyLoopTauntRegistrationAssignment> = {},
): ArmyLoopTauntRegistrationAssignment => ({
  assignmentId: 7,
  players: [1, 2],
  strategy: { type: "focus" },
  target: {
    focusActive: true,
    lifeRevision: 0,
    monsterMapId: 42,
    state: "alive",
  },
  ...options,
});

const makeRegistration = (
  sessionId: string,
  assignments: readonly ArmyLoopTauntRegistrationAssignment[] = [assignment()],
): ArmyLoopTauntRegisterPayload => ({
  map: {
    id: 100,
    name: "templeshrine",
    roomNumber: 1234,
  },
  priorityGroups: [{ assignments }],
  sessionId,
});

const makePriorityRegistration = (
  sessionId: string,
  priorityGroups: ArmyLoopTauntRegisterPayload["priorityGroups"],
): ArmyLoopTauntRegisterPayload => ({
  map: {
    id: 100,
    name: "templeshrine",
    roomNumber: 1234,
  },
  priorityGroups,
  sessionId,
});

const registerAll = Effect.fn("ArmyLoopTauntOrchestrator.test.registerAll")(
  function* (harness: Harness, registration: ArmyLoopTauntRegisterPayload) {
    const results = yield* Effect.all(
      harness.ids.map((senderId) =>
        harness.orchestrator.register(registration, senderId),
      ),
      { concurrency: "unbounded" },
    );
    const result = results[0];
    if (result === undefined) {
      throw new Error("Expected at least one registered participant");
    }
    expect(results.every(({ runId }) => runId === result.runId)).toBe(true);
    yield* Effect.all(
      harness.ids.map((senderId) =>
        harness.orchestrator.ready(
          {
            runId: result.runId,
            sessionId: harness.sessionId,
          },
          senderId,
        ),
      ),
      { concurrency: "unbounded" },
    );
    return result;
  },
);

const report = (
  harness: Harness,
  runId: string,
  senderId: number,
  value: ArmyLoopTauntReport,
) =>
  harness.orchestrator.report(
    {
      report: value,
      runId,
      sessionId: harness.sessionId,
    },
    senderId,
  );

const tauntEvents = (
  events: readonly ArmyLoopTauntCommandEvent[],
): readonly ArmyLoopTauntCommandEvent[] =>
  events.filter((event) => event.command.command.type === "taunt");

const warningLogger = (records: DesktopLogRecord[]) =>
  Logger.make((options) => {
    if (options.logLevel === "Warn") records.push(desktopLogRecord(options));
  });

const requireTaunt = (event: ArmyLoopTauntCommandEvent | undefined) => {
  if (event?.command.command.type !== "taunt") {
    throw new Error("Expected a loop-taunt command");
  }
  return event;
};

const advance = Effect.fn("ArmyLoopTauntOrchestrator.test.advance")(function* (
  duration: Parameters<typeof TestClock.adjust>[0],
) {
  yield* TestClock.adjust(duration);
  yield* Effect.yieldNow;
});

describe("ArmyLoopTauntOrchestrator", () => {
  it.effect(
    "does not publish a queued taunt after a report advances its turn",
    () =>
      Effect.gen(function* () {
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const harness = yield* makeHarness(["Alice", "Bob"]);
          const { runId } = yield* registerAll(
            harness,
            makePriorityRegistration(harness.sessionId, [
              { assignments: [assignment({ assignmentId: 6 })] },
              {
                assignments: [7, 8].map((assignmentId, index) =>
                  assignment({
                    assignmentId,
                    players: [index + 1],
                    target: {
                      focusActive: false,
                      lifeRevision: 0,
                      monsterMapId: 42,
                      state: "alive",
                    },
                  }),
                ),
              },
            ]),
          );
          for (const senderId of harness.ids) {
            yield* report(harness, runId, senderId, {
              alive: true,
              cooldownMs: 0,
              type: "participant-state",
              usable: true,
            });
          }
          yield* report(harness, runId, harness.ids[0]!, {
            assignmentId: 6,
            lifeRevision: 0,
            monsterMapId: 42,
            state: "dead",
            type: "target-state",
          });
          yield* harness.orchestrator.onCommand((event) =>
            event.command.command.type === "taunt" &&
            event.command.command.assignmentId === 7
              ? Deferred.succeed(publishing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                )
              : Effect.void,
          );
          const publishingReport = yield* report(
            harness,
            runId,
            harness.ids[1]!,
            {
              assignmentId: 6,
              lifeRevision: 0,
              monsterMapId: 42,
              state: "dead",
              type: "target-state",
            },
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(publishing);
          yield* report(harness, runId, harness.ids[0]!, {
            active: true,
            assignmentId: 8,
            lifeRevision: 0,
            monsterMapId: 42,
            type: "focus-state",
          });
          yield* report(harness, runId, harness.ids[0]!, {
            active: false,
            assignmentId: 8,
            lifeRevision: 0,
            monsterMapId: 42,
            type: "focus-state",
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(publishingReport);
          expect(
            tauntEvents(harness.events).map((event) => ({
              command: event.command.command,
              participantIds: event.participantIds,
            })),
          ).toMatchObject([
            {
              command: { type: "taunt", assignmentId: 7 },
              participantIds: [harness.ids[0]],
            },
            {
              command: { type: "taunt", assignmentId: 8 },
              participantIds: [harness.ids[1]],
            },
          ]);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
  );

  it.effect(
    "ignores superseded readiness and waits for the replacement roster",
    () =>
      Effect.gen(function* () {
        const activated = yield* Deferred.make<void>();
        const releaseActivation = yield* Deferred.make<void>();
        const replaced = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const harness = yield* makeHarness(
            ["Alice", "Bob"],
            (coordinator, ids) => {
              const calls = new Map<number, number>();
              return {
                ...coordinator,
                loopTaunt: (sessionId, senderId, step) =>
                  Effect.gen(function* () {
                    const outcome = yield* coordinator.loopTaunt(
                      sessionId,
                      senderId,
                      step,
                    );
                    const count = (calls.get(senderId) ?? 0) + 1;
                    calls.set(senderId, count);
                    if (senderId === ids[1] && count === 1) {
                      yield* Deferred.succeed(activated, undefined);
                      yield* Deferred.await(releaseActivation);
                    }
                    if (senderId === ids[0] && count === 3) {
                      yield* Deferred.succeed(replaced, undefined);
                      yield* Deferred.await(releaseReplacement);
                    }
                    return outcome;
                  }),
              };
            },
          );
          const registration = makeRegistration(harness.sessionId);
          const original = yield* harness.orchestrator.register(
            registration,
            harness.ids[0]!,
          );
          const originalReady = yield* harness.orchestrator
            .ready(
              { ...original, sessionId: harness.sessionId },
              harness.ids[0]!,
            )
            .pipe(Effect.result, Effect.forkScoped);
          yield* Effect.yieldNow;
          const activation = yield* harness.orchestrator
            .register(registration, harness.ids[1]!)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(activated);
          const replacement = yield* harness.orchestrator
            .register(registration, harness.ids[0]!)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(replaced);
          yield* Deferred.succeed(releaseActivation, undefined);
          yield* Fiber.join(activation);
          yield* Deferred.succeed(releaseReplacement, undefined);
          const next = yield* Fiber.join(replacement);
          expect(yield* Fiber.join(originalReady)).toMatchObject({
            _tag: "Failure",
            failure: {
              reason: "registration-failed",
              message: "Loop taunt registration was superseded",
            },
          });
          const nextReady = yield* harness.orchestrator
            .ready({ ...next, sessionId: harness.sessionId }, harness.ids[0]!)
            .pipe(Effect.as("ready"), Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(nextReady.pollUnsafe()).toBeUndefined();
          const nextBob = yield* harness.orchestrator.register(
            registration,
            harness.ids[1]!,
          );
          expect(nextBob.runId).toBe(next.runId);
          expect(yield* Fiber.join(nextReady)).toBe("ready");
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(releaseActivation, undefined),
              Deferred.succeed(releaseReplacement, undefined),
            ]),
          ),
        );
      }),
  );

  it.effect("publishes no Loop Taunt command after the session ends", () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<void>();
      const releaseEnd = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const harness = yield* makeHarness(
          ["Alice", "Bob"],
          (coordinator) => coordinator,
          (coordinator) =>
            coordinator
              .onSessionEnded(() =>
                Deferred.succeed(ended, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseEnd)),
                ),
              )
              .pipe(Effect.asVoid),
        );
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId),
        );
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: true,
          });
          yield* report(harness, runId, senderId, {
            active: false,
            assignmentId: 7,
            lifeRevision: 0,
            monsterMapId: 42,
            type: "focus-state",
          });
        }
        expect(
          tauntEvents(harness.events).map((event) => event.participantIds),
        ).toEqual([[harness.ids[0]]]);
        const commandCount = harness.events.length;
        const abort = yield* harness.coordinator
          .abortSession(harness.sessionId, {
            kind: "requested",
            reason: "Session stopped with a taunt pending",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ended);
        expect(yield* harness.coordinator.getSessions()).toEqual([]);
        yield* advance("7 seconds");
        const commandsAfterEnd = harness.events.slice(commandCount);
        yield* Deferred.succeed(releaseEnd, undefined);
        yield* Fiber.join(abort);
        expect(commandsAfterEnd).toEqual([]);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseEnd, undefined)));
    }),
  );

  it.effect("settles Loop Taunt waiters before session-ended listeners", () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<void>();
      const releaseEnd = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const harness = yield* makeHarness(
          ["Alice", "Bob"],
          (coordinator) => coordinator,
          (coordinator) =>
            coordinator
              .onSessionEnded(() =>
                Deferred.succeed(ended, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseEnd)),
                ),
              )
              .pipe(Effect.asVoid),
        );
        const { runId } = yield* harness.orchestrator.register(
          makeRegistration(harness.sessionId),
          harness.ids[0]!,
        );
        const sessions = yield* harness.coordinator.getSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).not.toHaveProperty("loopTaunt");
        const run = { runId, sessionId: harness.sessionId };
        const ready = yield* harness.orchestrator
          .ready(run, harness.ids[0]!)
          .pipe(Effect.result, Effect.forkScoped);
        const terminal = yield* harness.orchestrator
          .await(run, harness.ids[0]!)
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const abort = yield* harness.coordinator
          .abortSession(harness.sessionId, {
            kind: "requested",
            reason: "Session stopped during registration",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ended);
        yield* Effect.yieldNow;
        expect(ready.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            _tag: "Failure",
            failure: {
              reason: "registration-failed",
              message: "Session stopped during registration",
            },
          },
        });
        expect(terminal.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            reason: "Session stopped during registration",
            status: "failed",
          },
        });
        yield* Deferred.succeed(releaseEnd, undefined);
        yield* Fiber.join(abort);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseEnd, undefined)));
    }),
  );

  it.effect("an interrupted register still times out registration", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>();
      const releaseRegister = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const harness = yield* makeHarness(
          ["Alice", "Bob", "Carol"],
          (coordinator, [aliceId]) => ({
            ...coordinator,
            loopTaunt: (sessionId, participantId, step) => {
              const committedStep = coordinator.loopTaunt(
                sessionId,
                participantId,
                step,
              );
              return participantId === aliceId
                ? committedStep.pipe(
                    Effect.tap(() => Deferred.succeed(committed, undefined)),
                    Effect.tap(() => Deferred.await(releaseRegister)),
                  )
                : committedStep;
            },
          }),
        );
        const registration = makeRegistration(harness.sessionId);
        const alice = yield* harness.orchestrator
          .register(registration, harness.ids[0]!)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(committed);
        const interrupt = yield* Fiber.interrupt(alice).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseRegister, undefined);
        yield* Fiber.join(interrupt);
        expect(yield* Fiber.await(alice)).toMatchObject({ _tag: "Failure" });
        const bob = yield* harness.orchestrator.register(
          registration,
          harness.ids[1]!,
        );
        const pending = yield* harness.orchestrator
          .ready(
            { runId: bob.runId, sessionId: harness.sessionId },
            harness.ids[1]!,
          )
          .pipe(Effect.result, Effect.forkScoped);
        yield* advance("30 seconds");
        expect(pending.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            _tag: "Failure",
            failure: {
              reason: "registration-failed",
              message:
                "Loop taunt registration did not complete for the full Army roster within 30 seconds",
            },
          },
        });
      }).pipe(Effect.ensuring(Deferred.succeed(releaseRegister, undefined)));
    }),
  );

  it.effect(
    "activates with the full roster and taunts from periodic readiness reports",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const registration = makeRegistration(harness.sessionId, [
          assignment({
            target: {
              focusActive: false,
              lifeRevision: 0,
              monsterMapId: 42,
              state: "alive",
            },
          }),
        ]);
        const aliceRun = yield* harness.orchestrator.register(
          registration,
          harness.ids[0]!,
        );
        const aliceReady = yield* harness.orchestrator
          .ready(
            {
              runId: aliceRun.runId,
              sessionId: harness.sessionId,
            },
            harness.ids[0]!,
          )
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        expect(aliceReady.pollUnsafe()).toBeUndefined();
        expect(harness.events).toHaveLength(0);

        const bobRun = yield* harness.orchestrator.register(
          registration,
          harness.ids[1]!,
        );
        yield* harness.orchestrator.ready(
          {
            runId: bobRun.runId,
            sessionId: harness.sessionId,
          },
          harness.ids[1]!,
        );
        yield* Fiber.join(aliceReady);

        expect(aliceRun.runId).toBe(bobRun.runId);
        expect(harness.events).toEqual([]);
        yield* Effect.forever(
          Effect.forEach(
            harness.ids,
            (senderId) =>
              report(harness, aliceRun.runId, senderId, {
                alive: true,
                cooldownMs: 0,
                type: "participant-state",
                usable: true,
              }),
            { discard: true },
          ).pipe(Effect.andThen(Effect.sleep("250 millis"))),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(harness.events).toHaveLength(1);
        expect(requireTaunt(harness.events[0]).participantIds).toEqual([
          harness.ids[0],
        ]);
        expect(harness.events[0]?.command.command).toMatchObject({
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
          type: "taunt",
        });
      }),
  );

  it.effect("fails registration when the roster never becomes complete", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["Alice", "Bob"]);
      const run = yield* harness.orchestrator.register(
        makeRegistration(harness.sessionId),
        harness.ids[0]!,
      );
      const pending = yield* harness.orchestrator
        .ready(
          {
            runId: run.runId,
            sessionId: harness.sessionId,
          },
          harness.ids[0]!,
        )
        .pipe(Effect.forkScoped);

      yield* advance("29999 millis");
      expect(pending.pollUnsafe()).toBeUndefined();

      yield* advance("1 millis");
      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "registration-failed",
      });
      expect(error.message).toBe(
        "Loop taunt registration did not complete for the full Army roster within 30 seconds",
      );
    }),
  );

  it.effect("fails a collecting run when a registered participant leaves", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["Alice", "Bob"]);
      const registration = makeRegistration(harness.sessionId);
      const run = yield* harness.orchestrator.register(
        registration,
        harness.ids[0]!,
      );
      const pending = yield* harness.orchestrator
        .ready(
          {
            runId: run.runId,
            sessionId: harness.sessionId,
          },
          harness.ids[0]!,
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const duplicate = yield* harness.orchestrator
        .register(registration, harness.ids[0]!)
        .pipe(Effect.flip);
      expect(duplicate).toMatchObject({
        reason: "already-registered",
      });

      yield* harness.orchestrator.leave(
        {
          reason: "Alice stopped",
          runId: run.runId,
          sessionId: harness.sessionId,
        },
        harness.ids[0]!,
      );

      const error = yield* Fiber.join(pending).pipe(Effect.flip);
      expect(error).toMatchObject({
        message: "Alice stopped",
        reason: "registration-failed",
      });
    }),
  );

  it.effect(
    "does not resolve registration or publish commands after the session aborts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const run = yield* harness.orchestrator.register(
          makeRegistration(harness.sessionId),
          harness.ids[0]!,
        );
        const pending = yield* harness.orchestrator
          .ready(
            {
              runId: run.runId,
              sessionId: harness.sessionId,
            },
            harness.ids[0]!,
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* harness.coordinator.abortSession(harness.sessionId, {
          kind: "requested",
          reason: "Session aborted during loop-taunt registration",
        });

        const error = yield* Fiber.join(pending).pipe(Effect.flip);
        expect(error.message).toBe(
          "Session aborted during loop-taunt registration",
        );
        yield* advance("30 seconds");
        expect(harness.events).toHaveLength(0);
      }),
  );

  it.effect("validates priority groups and rejects roster plan drift", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["Alice", "Bob"]);
      const invalid = makePriorityRegistration(harness.sessionId, [
        {
          assignments: [
            assignment({ players: [1] }),
            assignment({ assignmentId: 8, players: [1] }),
          ],
        },
      ]);
      const invalidError = yield* harness.orchestrator
        .register(invalid, harness.ids[0]!)
        .pipe(Effect.flip);
      expect(invalidError).toMatchObject({
        reason: "invalid-registration",
      });
      expect(invalidError.message).toContain("same priority group");

      const left = assignment({ players: [1] });
      const right = assignment({
        assignmentId: 8,
        players: [2],
        target: {
          focusActive: true,
          lifeRevision: 0,
          monsterMapId: 43,
          state: "alive",
        },
      });
      const boss = assignment({
        assignmentId: 9,
        target: {
          focusActive: true,
          lifeRevision: 0,
          monsterMapId: 44,
          state: "alive",
        },
      });
      const registration = makePriorityRegistration(harness.sessionId, [
        { assignments: [left, right] },
        { assignments: [boss] },
      ]);
      const alice = yield* harness.orchestrator.register(
        registration,
        harness.ids[0]!,
      );
      const mismatch = makePriorityRegistration(harness.sessionId, [
        { assignments: [boss] },
        { assignments: [left, right] },
      ]);
      const mismatchError = yield* harness.orchestrator
        .register(mismatch, harness.ids[1]!)
        .pipe(Effect.flip);

      expect(mismatchError).toMatchObject({
        reason: "registration-mismatch",
      });
      expect(mismatchError.message).toContain("priority group boundaries");

      yield* harness.orchestrator.leave(
        {
          runId: alice.runId,
          sessionId: harness.sessionId,
        },
        harness.ids[0]!,
      );
    }),
  );

  it.effect(
    "waits for every assigned participant before selecting in configured order",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob", "Carol"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              players: [1, 2, 3],
              target: {
                focusActive: false,
                lifeRevision: 0,
                monsterMapId: 42,
                state: "alive",
              },
            }),
          ]),
        );
        const [alice, bob, carol] = harness.ids;

        yield* report(harness, runId, carol!, {
          alive: true,
          cooldownMs: 0,
          type: "participant-state",
          usable: true,
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, bob!, {
          alive: true,
          cooldownMs: 0,
          type: "participant-state",
          usable: true,
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, alice!, {
          alive: true,
          cooldownMs: 0,
          type: "participant-state",
          usable: true,
        });

        const first = requireTaunt(tauntEvents(harness.events)[0]);
        expect(first.participantIds).toEqual([alice]);
      }),
  );

  it.effect(
    "fails over a skipped attempt while ignoring the wrong sender",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const registration = makeRegistration(harness.sessionId, [
          assignment({
            target: {
              focusActive: false,
              lifeRevision: 0,
              monsterMapId: 42,
              state: "alive",
            },
          }),
        ]);
        const { runId } = yield* registerAll(harness, registration);
        const [alice, bob] = harness.ids;

        yield* Effect.forEach(
          [alice!, bob!],
          (participantId) =>
            report(harness, runId, participantId, {
              alive: true,
              cooldownMs: 0,
              type: "participant-state",
              usable: true,
            }),
          { discard: true },
        );
        const first = requireTaunt(tauntEvents(harness.events)[0]);
        expect(first.participantIds).toEqual([alice]);
        expect(first.command.command).toEqual({
          assignmentId: 7,
          expiresAt: 7_000,
          lifeRevision: 0,
          monsterMapId: 42,
          type: "taunt",
        });

        yield* report(harness, runId, bob!, {
          commandId: first.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });
        expect(tauntEvents(harness.events)).toHaveLength(1);

        yield* report(harness, runId, alice!, {
          commandId: first.command.commandId,
          outcome: "skipped",
          type: "command-result",
        });
        const second = requireTaunt(tauntEvents(harness.events)[1]);
        expect(second.participantIds).toEqual([bob]);
        expect(second.command.command).toMatchObject({
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
        });
      }),
  );

  it.effect(
    "retries an all-skipped rotation without degrading the assignment",
    () => {
      const warnings: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              target: {
                focusActive: false,
                lifeRevision: 0,
                monsterMapId: 42,
                state: "alive",
              },
            }),
          ]),
        );
        const [alice, bob] = harness.ids;

        yield* Effect.forEach(
          [alice!, bob!],
          (participantId) =>
            report(harness, runId, participantId, {
              alive: true,
              cooldownMs: 0,
              type: "participant-state",
              usable: true,
            }),
          { discard: true },
        );

        for (let sweep = 0; sweep < 2; sweep += 1) {
          const first = requireTaunt(tauntEvents(harness.events)[sweep * 2]);
          expect(first.participantIds).toEqual([alice]);
          yield* report(harness, runId, alice!, {
            commandId: first.command.commandId,
            outcome: "skipped",
            type: "command-result",
          });

          const second = requireTaunt(
            tauntEvents(harness.events)[sweep * 2 + 1],
          );
          expect(second.participantIds).toEqual([bob]);
          yield* report(harness, runId, bob!, {
            commandId: second.command.commandId,
            outcome: "skipped",
            type: "command-result",
          });

          expect(warnings).toHaveLength(0);
          expect(tauntEvents(harness.events)).toHaveLength((sweep + 1) * 2);
          if (sweep === 0) {
            yield* advance("1 second");
          }
        }
      }).pipe(Effect.withLogger(warningLogger(warnings)));
    },
  );

  it.effect(
    "immediately fails over when the pending participant becomes unusable",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              target: {
                focusActive: false,
                lifeRevision: 0,
                monsterMapId: 42,
                state: "alive",
              },
            }),
          ]),
        );
        const [alice, bob] = harness.ids;

        yield* report(harness, runId, bob!, {
          alive: true,
          cooldownMs: 0,
          type: "participant-state",
          usable: true,
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, alice!, {
          alive: true,
          cooldownMs: 0,
          type: "participant-state",
          usable: true,
        });
        const first = requireTaunt(tauntEvents(harness.events)[0]);
        expect(first.participantIds).toEqual([alice]);

        yield* report(harness, runId, alice!, {
          alive: false,
          cooldownMs: 0,
          type: "participant-state",
          usable: false,
        });

        const second = requireTaunt(tauntEvents(harness.events)[1]);
        expect(second.participantIds).toEqual([bob]);
        expect(second.command.commandId).not.toBe(first.command.commandId);
      }),
  );

  it.effect(
    "starts a focus assignment only when every observer loses focus",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId),
        );
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: true,
          });
        }

        yield* report(harness, runId, harness.ids[0]!, {
          active: false,
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
          type: "focus-state",
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, harness.ids[1]!, {
          active: false,
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
          type: "focus-state",
        });
        expect(tauntEvents(harness.events)).toHaveLength(1);
      }),
  );

  it.effect(
    "retains a one-shot message until target-life consensus catches up",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              strategy: {
                message: "the seal is broken",
                type: "message",
              },
            }),
          ]),
        );
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: true,
          });
        }

        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          focusActive: false,
          lifeRevision: 1,
          monsterMapId: 99,
          state: "alive",
          type: "target-state",
        });
        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          lifeRevision: 1,
          message: "The seal is broken!",
          monsterMapId: 99,
          type: "message",
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, harness.ids[1]!, {
          assignmentId: 7,
          focusActive: false,
          lifeRevision: 1,
          monsterMapId: 99,
          state: "alive",
          type: "target-state",
        });

        const retained = requireTaunt(tauntEvents(harness.events)[0]);
        expect(retained.participantIds).toEqual([harness.ids[0]]);
        expect(retained.command.command).toMatchObject({
          assignmentId: 7,
          lifeRevision: 1,
          monsterMapId: 99,
          type: "taunt",
        });
      }),
  );

  it.effect(
    "matches and deduplicates message assignments across observers",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              strategy: {
                message: "your defenses are broken",
                type: "message",
              },
            }),
          ]),
        );
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: true,
          });
        }

        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          lifeRevision: 0,
          message: "Nothing relevant happened",
          monsterMapId: 42,
          type: "message",
        });
        expect(tauntEvents(harness.events)).toHaveLength(0);

        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          lifeRevision: 0,
          message: "  YOUR   defenses are broken!  ",
          monsterMapId: 42,
          type: "message",
        });
        const first = requireTaunt(tauntEvents(harness.events)[0]);
        yield* report(harness, runId, harness.ids[0]!, {
          commandId: first.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });

        yield* advance("499 millis");
        yield* report(harness, runId, harness.ids[1]!, {
          assignmentId: 7,
          lifeRevision: 0,
          message: "your defenses are broken",
          monsterMapId: 42,
          type: "message",
        });
        expect(tauntEvents(harness.events)).toHaveLength(1);

        yield* advance("1 millis");
        yield* report(harness, runId, harness.ids[1]!, {
          assignmentId: 7,
          lifeRevision: 0,
          message: "your defenses are broken",
          monsterMapId: 42,
          type: "message",
        });
        const second = requireTaunt(tauntEvents(harness.events)[1]);
        expect(second.participantIds).toEqual([harness.ids[1]]);
      }),
  );

  it.effect(
    "makes active leave idempotent and completes and retires after the last leave",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId),
        );
        const waiting = yield* harness.orchestrator
          .await(
            {
              runId,
              sessionId: harness.sessionId,
            },
            harness.ids[0]!,
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const leave = {
          runId,
          sessionId: harness.sessionId,
        };

        yield* harness.orchestrator.leave(leave, harness.ids[0]!);
        yield* harness.orchestrator.leave(leave, harness.ids[0]!);
        expect(waiting.pollUnsafe()).toBeUndefined();

        yield* harness.orchestrator.leave(leave, harness.ids[1]!);
        expect(yield* Fiber.join(waiting)).toEqual({
          status: "completed",
        });
        yield* harness.orchestrator.leave(leave, harness.ids[1]!);
        expect(
          yield* harness.orchestrator
            .await(leave, harness.ids[1]!)
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: "inactive-run", runId },
        });
      }),
  );

  it.effect(
    "serves a finished run's result to late awaits and retires it after every participant leaves",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId),
        );
        const run = { runId, sessionId: harness.sessionId };

        yield* report(harness, runId, harness.ids[0]!, {
          reason: "Alice changed maps",
          type: "failed",
        });
        yield* harness.orchestrator.leave(run, harness.ids[0]!);

        expect(yield* harness.orchestrator.await(run, harness.ids[1]!)).toEqual(
          {
            reason: "Alice changed maps",
            status: "failed",
          },
        );
        expect(
          yield* harness.orchestrator
            .ready(run, harness.ids[1]!)
            .pipe(Effect.flip),
        ).toMatchObject({
          message: "Alice changed maps",
          reason: "registration-failed",
        });

        yield* harness.orchestrator.leave(run, harness.ids[1]!);

        const afterRetirement = yield* Effect.forEach(harness.ids, (senderId) =>
          harness.orchestrator.await(run, senderId).pipe(Effect.result),
        );
        expect(afterRetirement).toMatchObject([
          { _tag: "Failure", failure: { reason: "inactive-run", runId } },
          { _tag: "Failure", failure: { reason: "inactive-run", runId } },
        ]);
      }),
  );

  it.effect("rejects an unseated registrant", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["Alice", "Bob"]);
      const registration = makeRegistration(harness.sessionId);
      yield* harness.orchestrator.register(registration, harness.ids[1]!);
      const rejected = yield* harness.orchestrator
        .register(registration, -1)
        .pipe(Effect.flip);
      expect(rejected).toMatchObject({ reason: "sender-mismatch" });
    }),
  );

  it.effect(
    "replaces an active generation and isolates stale leave from its replacement",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const registration = makeRegistration(harness.sessionId);
        const { runId: firstRunId } = yield* registerAll(harness, registration);
        const firstWait = yield* harness.orchestrator
          .await(
            {
              runId: firstRunId,
              sessionId: harness.sessionId,
            },
            harness.ids[1]!,
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const nextAlice = yield* harness.orchestrator.register(
          registration,
          harness.ids[0]!,
        );
        expect(yield* Fiber.join(firstWait)).toEqual({
          status: "completed",
        });

        yield* harness.orchestrator.leave(
          {
            runId: firstRunId,
            sessionId: harness.sessionId,
          },
          harness.ids[0]!,
        );
        const nextBob = yield* harness.orchestrator.register(
          registration,
          harness.ids[1]!,
        );

        expect(nextAlice.runId).toBe(nextBob.runId);
        expect(nextAlice.runId).not.toBe(firstRunId);
        yield* Effect.all(
          harness.ids.map((senderId) =>
            harness.orchestrator.ready(
              {
                runId: nextAlice.runId,
                sessionId: harness.sessionId,
              },
              senderId,
            ),
          ),
          { concurrency: "unbounded" },
        );
        const nextWait = yield* harness.orchestrator
          .await(
            {
              runId: nextAlice.runId,
              sessionId: harness.sessionId,
            },
            harness.ids[1]!,
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(nextWait.pollUnsafe()).toBeUndefined();

        yield* harness.orchestrator.leave(
          {
            runId: nextAlice.runId,
            sessionId: harness.sessionId,
          },
          harness.ids[0]!,
        );
        yield* harness.orchestrator.leave(
          {
            runId: nextAlice.runId,
            sessionId: harness.sessionId,
          },
          harness.ids[1]!,
        );
        expect(yield* Fiber.join(nextWait)).toEqual({
          status: "completed",
        });
      }),
  );

  it.effect(
    "debounces each consensus episode and ignores earlier episode timers",
    () => {
      const warnings: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId),
        );
        const targetState = (state: "alive" | "dead") =>
          report(harness, runId, harness.ids[0]!, {
            assignmentId: 7,
            lifeRevision: 0,
            monsterMapId: 42,
            state,
            type: "target-state",
          });

        yield* targetState("dead");
        yield* advance("1 second");
        yield* targetState("alive");
        yield* advance("1 second");
        yield* targetState("dead");
        yield* advance("1 second");
        expect(warnings).toEqual([]);
        yield* advance("1999 millis");
        expect(warnings).toEqual([]);
        yield* advance("1 millis");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          component: "army",
          data: { assignmentId: 7, code: "degraded", runId },
          level: "warn",
          message: "Loop Taunt is degraded",
        });

        yield* targetState("alive");
        yield* targetState("dead");
        yield* advance("3 seconds");
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toMatchObject({
          data: { assignmentId: 7, code: "degraded", runId },
        });
      }).pipe(Effect.withLogger(warningLogger(warnings)));
    },
  );

  it.effect(
    "keeps sustained target disagreement active and warns exactly once",
    () => {
      const warnings: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              players: [1],
              target: {
                focusActive: false,
                lifeRevision: 0,
                monsterMapId: 42,
                state: "alive",
              },
            }),
          ]),
        );
        const waiting = yield* harness.orchestrator
          .await(
            {
              runId,
              sessionId: harness.sessionId,
            },
            harness.ids[1]!,
          )
          .pipe(Effect.forkScoped);

        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
          state: "dead",
          type: "target-state",
        });
        yield* advance("2999 millis");
        expect(warnings).toHaveLength(0);

        yield* advance("1 millis");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          component: "army",
          data: { assignmentId: 7, code: "degraded", runId },
          level: "warn",
          message: "Loop Taunt is degraded",
        });

        yield* advance("60 seconds");
        expect(waiting.pollUnsafe()).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }).pipe(Effect.withLogger(warningLogger(warnings)));
    },
  );

  it.effect(
    "keeps retrying degraded readiness and recovers through periodic reports",
    () => {
      const warnings: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob"]);
        const { runId } = yield* registerAll(
          harness,
          makeRegistration(harness.sessionId, [
            assignment({
              target: {
                focusActive: false,
                lifeRevision: 0,
                monsterMapId: 42,
                state: "alive",
              },
            }),
          ]),
        );
        const waiting = yield* harness.orchestrator
          .await({ runId, sessionId: harness.sessionId }, harness.ids[0]!)
          .pipe(Effect.forkScoped);

        yield* advance("1999 millis");
        expect(warnings).toEqual([]);
        yield* advance("1 millis");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          component: "army",
          data: { assignmentId: 7, code: "degraded", runId },
          level: "warn",
          message: "Loop Taunt is degraded",
        });
        yield* advance("60 seconds");
        expect(waiting.pollUnsafe()).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(harness.events).toEqual([]);

        const periodic = yield* Effect.forever(
          Effect.forEach(
            harness.ids,
            (senderId) =>
              report(harness, runId, senderId, {
                alive: true,
                cooldownMs: 0,
                type: "participant-state",
                usable: true,
              }),
            { discard: true },
          ).pipe(Effect.andThen(Effect.sleep("250 millis"))),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const first = requireTaunt(harness.events[0]);
        expect(first.participantIds).toEqual([harness.ids[0]]);
        yield* report(harness, runId, harness.ids[0]!, {
          commandId: first.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });
        yield* advance("1 second");
        expect(harness.events).toHaveLength(1);
        expect(warnings).toHaveLength(1);
        yield* Fiber.interrupt(periodic);
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: false,
          });
          yield* report(harness, runId, senderId, {
            active: false,
            assignmentId: 7,
            lifeRevision: 0,
            monsterMapId: 42,
            type: "focus-state",
          });
        }
        yield* advance("1999 millis");
        expect(warnings).toHaveLength(1);
        yield* advance("1 millis");
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toMatchObject({
          data: { assignmentId: 7, code: "degraded", runId },
        });

        yield* harness.coordinator.abortSession(harness.sessionId, {
          kind: "requested",
          reason: "Session ended",
        });
        expect(yield* Fiber.join(waiting)).toEqual({
          reason: "Session ended",
          status: "failed",
        });
        yield* advance("2 seconds");
        expect(harness.events).toHaveLength(1);
      }).pipe(Effect.withLogger(warningLogger(warnings)));
    },
  );

  it.effect("waits for an assigned participant's reported cooldown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["Alice", "Bob"]);
      const { runId } = yield* registerAll(
        harness,
        makeRegistration(harness.sessionId),
      );
      yield* report(harness, runId, harness.ids[0]!, {
        alive: true,
        cooldownMs: 5_000,
        type: "participant-state",
        usable: true,
      });
      yield* report(harness, runId, harness.ids[1]!, {
        alive: true,
        cooldownMs: 0,
        type: "participant-state",
        usable: false,
      });
      for (const senderId of harness.ids) {
        yield* report(harness, runId, senderId, {
          active: false,
          assignmentId: 7,
          lifeRevision: 0,
          monsterMapId: 42,
          type: "focus-state",
        });
      }

      yield* advance("4999 millis");
      expect(tauntEvents(harness.events)).toHaveLength(0);

      yield* advance("1 millis");
      const event = requireTaunt(tauntEvents(harness.events)[0]);
      expect(event.participantIds).toEqual([harness.ids[0]]);
    }),
  );

  it.effect(
    "runs the first living priority group and resets its cursor on respawn",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(["Alice", "Bob", "Carol", "Dave"]);
        const left = assignment({
          players: [1, 2],
          target: {
            focusActive: false,
            lifeRevision: 0,
            monsterMapId: 42,
            state: "alive",
          },
        });
        const right = assignment({
          assignmentId: 8,
          players: [3, 4],
          target: {
            focusActive: false,
            lifeRevision: 0,
            monsterMapId: 43,
            state: "alive",
          },
        });
        const boss = assignment({
          assignmentId: 9,
          players: [1, 2, 3, 4],
          target: {
            focusActive: false,
            lifeRevision: 0,
            monsterMapId: 44,
            state: "alive",
          },
        });
        const { runId } = yield* registerAll(
          harness,
          makePriorityRegistration(harness.sessionId, [
            { assignments: [left, right] },
            { assignments: [boss] },
          ]),
        );
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            alive: true,
            cooldownMs: 0,
            type: "participant-state",
            usable: true,
          });
        }
        const initial = tauntEvents(harness.events);
        expect(initial).toHaveLength(2);
        const leftFirst = requireTaunt(
          initial.find(
            (event) =>
              event.command.command.type === "taunt" &&
              event.command.command.assignmentId === 7,
          ),
        );
        const rightFirst = requireTaunt(
          initial.find(
            (event) =>
              event.command.command.type === "taunt" &&
              event.command.command.assignmentId === 8,
          ),
        );
        expect(leftFirst.participantIds).toEqual([harness.ids[0]]);
        expect(rightFirst.participantIds).toEqual([harness.ids[2]]);

        yield* report(harness, runId, harness.ids[0]!, {
          commandId: leftFirst.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });
        yield* report(harness, runId, harness.ids[2]!, {
          commandId: rightFirst.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });

        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            assignmentId: 7,
            lifeRevision: 0,
            monsterMapId: 42,
            state: "dead",
            type: "target-state",
          });
        }
        for (const senderId of harness.ids.slice(0, -1)) {
          yield* report(harness, runId, senderId, {
            assignmentId: 8,
            lifeRevision: 0,
            monsterMapId: 43,
            state: "dead",
            type: "target-state",
          });
        }
        expect(tauntEvents(harness.events)).toHaveLength(2);

        yield* report(harness, runId, harness.ids[3]!, {
          assignmentId: 8,
          lifeRevision: 0,
          monsterMapId: 43,
          state: "dead",
          type: "target-state",
        });
        const bossFirst = requireTaunt(tauntEvents(harness.events)[2]);
        expect(bossFirst.participantIds).toEqual([harness.ids[0]]);
        expect(bossFirst.command.command).toMatchObject({
          assignmentId: 9,
          lifeRevision: 0,
          monsterMapId: 44,
          type: "taunt",
        });

        yield* report(harness, runId, harness.ids[0]!, {
          commandId: bossFirst.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });
        for (const senderId of harness.ids) {
          yield* report(harness, runId, senderId, {
            active: false,
            assignmentId: 9,
            lifeRevision: 0,
            monsterMapId: 44,
            type: "focus-state",
          });
        }
        const bossSecond = requireTaunt(tauntEvents(harness.events)[3]);
        expect(bossSecond.participantIds).toEqual([harness.ids[1]]);

        yield* report(harness, runId, harness.ids[0]!, {
          assignmentId: 7,
          focusActive: false,
          lifeRevision: 1,
          monsterMapId: 52,
          state: "alive",
          type: "target-state",
        });
        yield* report(harness, runId, harness.ids[1]!, {
          commandId: bossSecond.command.commandId,
          outcome: "confirmed",
          type: "command-result",
        });
        expect(tauntEvents(harness.events)).toHaveLength(4);

        for (const senderId of harness.ids.slice(1)) {
          yield* report(harness, runId, senderId, {
            assignmentId: 7,
            focusActive: false,
            lifeRevision: 1,
            monsterMapId: 52,
            state: "alive",
            type: "target-state",
          });
        }
        const respawnedLeft = requireTaunt(tauntEvents(harness.events)[4]);
        expect(respawnedLeft.participantIds).toEqual([harness.ids[0]]);
        expect(respawnedLeft.command.command).toMatchObject({
          assignmentId: 7,
          lifeRevision: 1,
          monsterMapId: 52,
          type: "taunt",
        });
      }),
  );
});
