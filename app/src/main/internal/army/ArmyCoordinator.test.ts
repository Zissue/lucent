import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import type { ArmyConfigPayload } from "@lucent/core/army";
import {
  ARMY_SYNC_TIMEOUT_MS,
  arriveAtStep,
  endSession,
  initialCoordinatorState,
  joinSession,
  makeArmyCoordinator,
  type ArmyCoordinatorState,
  type ArmyParticipant,
  type ArmySessionEndedEvent,
} from "./ArmyCoordinator";

let nextParticipantId = 1;

const makeParticipant = (): number => nextParticipantId++;

const live = (rendererId: number): ArmyParticipant => ({
  rendererId,
  isCurrent: () => true,
});

const makeConfig = (players: readonly string[]): ArmyConfigPayload => ({
  configName: "test",
  items: {},
  players,
  raw: { players, room: "1234" },
  room: "1234",
  sets: {},
});

describe("ArmyCoordinator", () => {
  it.effect(
    "rejects an unavailable participant without creating a session",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const error = yield* Effect.flip(
          coordinator.join(makeConfig(["Alice"]), "Alice", {
            rendererId: 7,
            isCurrent: () => false,
          }),
        );

        expect(error).toMatchObject({
          _tag: "ArmyParticipantError",
          reason: "unavailable",
          message: "Army window is no longer available",
          playerName: "Alice",
        });
        expect(yield* coordinator.getSessions()).toEqual([]);
      }),
  );

  it.effect("publishes session-ended events without an IPC dependency", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const participantId = makeParticipant();
      const events: Array<unknown> = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      const session = yield* coordinator.join(
        makeConfig(["Alice"]),
        "Alice",
        live(participantId),
      );

      yield* coordinator.abortSession(session.sessionId, {
        kind: "requested",
        reason: "Test complete",
      });

      expect(events).toEqual([
        {
          participantIds: [participantId],
          reason: "Test complete",
          sessionId: session.sessionId,
        },
      ]);
    }),
  );

  it.effect(
    "allows the same renderer window to start from step zero after its generation is aborted",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const participantId = makeParticipant();
        const config = makeConfig(["Alice"]);
        const first = yield* coordinator.join(
          config,
          "Alice",
          live(participantId),
        );
        yield* coordinator.sync(first.sessionId, participantId, {
          label: "first-run",
          step: 0,
        });

        yield* coordinator.abortParticipant(participantId, {
          kind: "participant-unavailable",
          reason: "Renderer reloaded",
        });

        const second = yield* coordinator.join(
          config,
          "Alice",
          live(participantId),
        );
        yield* coordinator.sync(second.sessionId, participantId, {
          label: "second-run",
          step: 0,
        });

        expect(second.sessionId).not.toBe(first.sessionId);
        expect(
          (yield* coordinator.getSessions()).map(({ sessionId }) => sessionId),
        ).toEqual([second.sessionId]);
      }),
  );

  it.effect("starts only after the full configured roster joins", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const alice = yield* coordinator
        .join(makeConfig(["Alice", "Bob"]), "Alice", live(aliceWindow))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      expect(alice.pollUnsafe()).toBeUndefined();

      const bob = yield* coordinator.join(
        makeConfig(["Alice", "Bob"]),
        "Bob",
        live(bobWindow),
      );
      const alicePayload = yield* Fiber.join(alice);

      expect(alicePayload.role).toBe("leader");
      expect(alicePayload.playerNumber).toBe(1);
      expect(bob.role).toBe("member");
      expect(bob.playerNumber).toBe(2);
    }),
  );

  it.effect("logs the active checkpoint when a session aborts", () => {
    const records: unknown[] = [];
    return Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const [alice] = yield* Effect.all(
        [
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Alice",
            live(aliceWindow),
          ),
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Bob",
            live(bobWindow),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      const waiting = yield* coordinator
        .sync(alice.sessionId, aliceWindow, {
          label: "map:whitemap-1234",
          step: 0,
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* coordinator.abortParticipant(aliceWindow, {
        kind: "participant-unavailable",
        reason: "Army window closed",
      });
      expect(Result.isFailure(yield* Fiber.join(waiting))).toBe(true);
      yield* Effect.yieldNow;

      expect(records).toContainEqual(
        expect.objectContaining({
          level: "Warn",
          data: expect.objectContaining({
            sessionId: alice.sessionId,
            cause: {
              kind: "participant-unavailable",
              reason: "Army window closed",
            },
            checkpoints: [
              expect.objectContaining({
                label: "map:whitemap-1234",
                step: 0,
                arrivedPlayers: ["Alice"],
                missingPlayers: ["Bob"],
                timeoutMs: ARMY_SYNC_TIMEOUT_MS,
              }),
            ],
          }),
        }),
      );
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            records.push({
              level: options.logLevel,
              ...options.fiber.getRef(References.CurrentLogAnnotations),
            });
          }),
        ]),
      ),
    );
  });

  it.effect("rejects a second sender for an attached player", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      yield* coordinator.join(
        makeConfig(["Alice"]),
        "Alice",
        live(makeParticipant()),
      );
      const error = yield* Effect.flip(
        coordinator.join(
          makeConfig(["Alice"]),
          "Alice",
          live(makeParticipant()),
        ),
      );
      expect(error.message).toBe("Army player already joined: Alice");
    }),
  );

  it.effect("rejects operations from a sender that did not join", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const session = yield* coordinator.join(
        makeConfig(["Alice"]),
        "Alice",
        live(aliceWindow),
      );
      const error = yield* Effect.flip(
        coordinator.sync(session.sessionId, makeParticipant(), {
          label: "sync",
          step: 0,
        }),
      );
      expect(error.message).toBe("Army sender is not attached to this session");
      expect((yield* coordinator.getSessions()).length).toBe(1);
    }),
  );

  it.effect("returns the authenticated canonical roster identity", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const [alice] = yield* Effect.all(
        [
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            " alice ",
            live(aliceWindow),
          ),
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "BOB",
            live(bobWindow),
          ),
        ],
        { concurrency: "unbounded" },
      );

      expect(
        yield* coordinator.requireParticipant(alice.sessionId, aliceWindow),
      ).toEqual({
        playerCount: 2,
        playerName: "Alice",
        playerNumber: 1,
        sessionId: alice.sessionId,
      });
    }),
  );

  it.effect("aborts a collecting session when roster startup times out", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const pending = yield* coordinator
        .join(makeConfig(["Alice", "Bob"]), "Alice", live(makeParticipant()))
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(pending);

      expect(Result.isFailure(result)).toBe(true);
      expect((yield* coordinator.getSessions()).length).toBe(0);
    }),
  );

  it.effect("aborts every waiter when step signatures disagree", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const [alice, bob] = yield* Effect.all(
        [
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Alice",
            live(aliceWindow),
          ),
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Bob",
            live(bobWindow),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const aliceWait = yield* coordinator
        .sync(alice.sessionId, aliceWindow, { label: "first", step: 0 })
        .pipe(Effect.result, Effect.forkScoped);
      const bobError = yield* Effect.flip(
        coordinator.sync(bob.sessionId, bobWindow, {
          label: "second",
          step: 0,
        }),
      );
      const aliceResult = yield* Fiber.join(aliceWait);

      expect(bobError.message).toContain("Army step mismatch for step 0");
      expect(Result.isFailure(aliceResult)).toBe(true);
      expect((yield* coordinator.getSessions()).length).toBe(0);
    }),
  );

  it.effect(
    "repeats local progress rounds until every player is complete",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const aliceWindow = makeParticipant();
        const bobWindow = makeParticipant();
        const [alice, bob] = yield* Effect.all(
          [
            coordinator.join(
              makeConfig(["Alice", "Bob"]),
              "Alice",
              live(aliceWindow),
            ),
            coordinator.join(
              makeConfig(["Alice", "Bob"]),
              "Bob",
              live(bobWindow),
            ),
          ],
          { concurrency: "unbounded" },
        );

        const roundOne = yield* Effect.all(
          [
            coordinator.progress(alice.sessionId, aliceWindow, {
              complete: true,
              label: "kill-item",
              step: 0,
            }),
            coordinator.progress(bob.sessionId, bobWindow, {
              complete: false,
              label: "kill-item",
              step: 0,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(roundOne[0]).toEqual({
          complete: false,
          completedPlayers: ["Alice"],
          pendingPlayers: ["Bob"],
        });

        const roundTwo = yield* Effect.all(
          [
            coordinator.progress(alice.sessionId, aliceWindow, {
              complete: true,
              label: "kill-item",
              step: 0,
            }),
            coordinator.progress(bob.sessionId, bobWindow, {
              complete: true,
              label: "kill-item",
              step: 0,
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(roundTwo[0].complete).toBe(true);
        expect(roundTwo[0].pendingPlayers).toEqual([]);
      }),
  );

  it.effect("ends a collecting session when the start times out", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const pending = yield* coordinator
        .join(makeConfig(["Alice", "Bob"]), "Alice", live(aliceWindow))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("120 seconds");

      expect((yield* Fiber.join(pending)).message).toBe(
        "Timed out waiting for army players; missing: Bob",
      );
      expect(
        events.map(({ participantIds, reason }) => ({
          participantIds,
          reason,
        })),
      ).toEqual([
        {
          participantIds: [aliceWindow],
          reason: "Timed out waiting for army players; missing: Bob",
        },
      ]);
    }),
  );

  it.effect("releases every waiting player when a player fails", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const [alice] = yield* Effect.all(
        [
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Alice",
            live(aliceWindow),
          ),
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Bob",
            live(bobWindow),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const waiting = yield* coordinator
        .sync(alice.sessionId, aliceWindow, { label: "boss", step: 0 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* coordinator.fail(alice.sessionId, bobWindow, "Boss vanished");

      expect((yield* Fiber.join(waiting)).message).toBe(
        "Army failed for Bob: Boss vanished",
      );
      expect(events).toEqual([
        {
          participantIds: [aliceWindow, bobWindow],
          reason: "Army failed for Bob: Boss vanished",
          sessionId: alice.sessionId,
        },
      ]);
      expect((yield* coordinator.getSessions()).length).toBe(0);
    }),
  );

  it.effect("ends a collecting session when a joined player leaves", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const config = makeConfig(["Alice", "Bob", "Carol"]);
      const bob = yield* coordinator
        .join(config, "Bob", live(bobWindow))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* coordinator
        .join(config, "Alice", live(aliceWindow))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* coordinator.leave(aliceWindow);
      yield* coordinator.leave(aliceWindow);

      expect((yield* Fiber.join(bob)).message).toBe("Army player left: Alice");
      expect(
        events.map(({ participantIds, reason }) => ({
          participantIds,
          reason,
        })),
      ).toEqual([
        {
          participantIds: [bobWindow, aliceWindow],
          reason: "Army player left: Alice",
        },
      ]);
    }),
  );

  it.effect("releases peers when a player's renderer goes away", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const aliceWindow = makeParticipant();
      const bobWindow = makeParticipant();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const [alice] = yield* Effect.all(
        [
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Alice",
            live(aliceWindow),
          ),
          coordinator.join(
            makeConfig(["Alice", "Bob"]),
            "Bob",
            live(bobWindow),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const waiting = yield* coordinator
        .progress(alice.sessionId, aliceWindow, {
          complete: true,
          label: "kill-item:Trophy",
          step: 0,
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* coordinator.abortParticipant(bobWindow, {
        kind: "participant-unavailable",
        reason: "Army window closed",
      });

      expect((yield* Fiber.join(waiting)).message).toBe("Army window closed");
      expect(events).toEqual([
        {
          participantIds: [aliceWindow, bobWindow],
          reason: "Army window closed",
          sessionId: alice.sessionId,
        },
      ]);
    }),
  );

  it.effect(
    "keeps a farming step open past its timeout once every player has reported",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const aliceWindow = makeParticipant();
        const bobWindow = makeParticipant();
        const [alice] = yield* Effect.all(
          [
            coordinator.join(
              makeConfig(["Alice", "Bob"]),
              "Alice",
              live(aliceWindow),
            ),
            coordinator.join(
              makeConfig(["Alice", "Bob"]),
              "Bob",
              live(bobWindow),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const report = (window: number, complete: boolean) =>
          coordinator.progress(alice.sessionId, window, {
            complete,
            label: "kill-item:Trophy",
            step: 0,
            timeoutMs: 1_000,
          });

        yield* Effect.all(
          [report(aliceWindow, true), report(bobWindow, false)],
          {
            concurrency: "unbounded",
          },
        );
        const aliceWaiting = yield* report(aliceWindow, true).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        expect(aliceWaiting.pollUnsafe()).toBeUndefined();

        const bobDone = yield* report(bobWindow, true);
        const done = {
          complete: true,
          completedPlayers: ["Alice", "Bob"],
          pendingPlayers: [],
        };
        expect(bobDone).toEqual(done);
        expect(yield* Fiber.join(aliceWaiting)).toEqual(done);
        expect(yield* report(aliceWindow, false)).toEqual(done);
      }),
  );
});

describe("army registration interruption", () => {
  it.effect("ends a join interrupted after registration commits", () => {
    let interrupted = 0;
    return Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const joining = yield* coordinator
        .join(makeConfig(["Alice"]), "Alice", live(1))
        .pipe(Effect.forkScoped);
      yield* Fiber.await(joining);
      expect(interrupted).toBe(1);
      expect(yield* coordinator.getSessions()).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({
          participantIds: [1],
          reason: "Army start interrupted",
        }),
      ]);
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            if (
              options.message === "Army session started" ||
              (Array.isArray(options.message) &&
                options.message.includes("Army session started"))
            ) {
              interrupted += 1;
              options.fiber.interruptUnsafe();
            }
          }),
        ]),
      ),
    );
  });
});

describe("army checkpoint cursor", () => {
  it.effect("ends immediately when a player skips the expected step", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const events: ArmySessionEndedEvent[] = [];
      yield* coordinator.onSessionEnded((event) =>
        Effect.sync(() => events.push(event)),
      );
      const session = yield* coordinator.join(
        makeConfig(["Alice"]),
        "Alice",
        live(1),
      );
      const error = yield* Effect.flip(
        coordinator.sync(session.sessionId, 1, { step: 1 }),
      );
      expect(error).toMatchObject({
        reason: "signature-mismatch",
        message: "Army step mismatch: expected step 0, received step 1",
      });
      expect(events).toEqual([
        {
          participantIds: [1],
          reason: error.message,
          sessionId: session.sessionId,
        },
      ]);
      expect(yield* coordinator.getSessions()).toEqual([]);
    }),
  );

  it.effect("only repeats the immediately preceding progress completion", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeArmyCoordinator();
      const session = yield* coordinator.join(
        makeConfig(["Alice"]),
        "Alice",
        live(1),
      );
      const report = (step: number) =>
        coordinator.progress(session.sessionId, 1, {
          complete: true,
          label: "farm",
          step,
        });
      const done = {
        complete: true,
        completedPlayers: ["Alice"],
        pendingPlayers: [],
      };
      expect(yield* report(0)).toEqual(done);
      expect(yield* report(0)).toEqual(done);
      expect(yield* report(1)).toEqual(done);
      expect(yield* report(1)).toEqual(done);
      expect(yield* Effect.flip(report(0))).toMatchObject({
        reason: "completed-step",
      });
      expect(yield* coordinator.getSessions()).toEqual([]);
    }),
  );

  for (const kind of ["barrier", "progress"] as const) {
    it.effect(
      `rejects a completed step with a different ${kind} signature`,
      () =>
        Effect.gen(function* () {
          const coordinator = yield* makeArmyCoordinator();
          const session = yield* coordinator.join(
            makeConfig(["Alice"]),
            "Alice",
            live(1),
          );
          yield* coordinator.progress(session.sessionId, 1, {
            complete: true,
            label: "farm",
            step: 0,
          });
          const payload = { complete: true, label: "other", step: 0 };
          const error = yield* Effect.flip(
            kind === "barrier"
              ? coordinator.sync(session.sessionId, 1, payload)
              : coordinator.progress(session.sessionId, 1, payload),
          );
          expect(error).toMatchObject({ reason: "completed-step" });
          expect(yield* coordinator.getSessions()).toEqual([]);
        }),
    );
  }
});

describe("army session transitions", () => {
  const config = makeConfig(["Alice", "Bob"]);

  const activeSession = (): ArmyCoordinatorState => {
    let state = initialCoordinatorState;
    for (const [playerName, participantId] of [
      ["Alice", 1],
      ["Bob", 2],
    ] as const) {
      state = joinSession(state, {
        config,
        nowMs: 0,
        participantId,
        playerName,
        waiter: Deferred.makeUnsafe(),
      }).state;
    }
    return state;
  };

  const report = (
    state: ArmyCoordinatorState,
    participantId: number,
    complete: boolean,
  ) =>
    arriveAtStep(state, {
      complete,
      nowMs: 0,
      participantId,
      sessionId: "0-0",
      signature: { kind: "progress", label: "kill", timeoutMs: 1_000 },
      step: 0,
      waiter: Deferred.makeUnsafe(),
    });

  it("releases the first progress round once, then only on completion", () => {
    const alice = report(activeSession(), 1, true);
    const bob = report(alice.state, 2, false);
    const aliceAgain = report(bob.state, 1, true);
    const bobDone = report(aliceAgain.state, 2, true);

    const released = (effects: typeof alice.effects) =>
      effects.flatMap((effect) =>
        effect.type === "Released"
          ? [{ result: effect.result, waiters: effect.waiters.length }]
          : [],
      );
    expect(released(alice.effects)).toEqual([]);
    expect(released(bob.effects)).toEqual([
      {
        result: {
          complete: false,
          completedPlayers: ["Alice"],
          pendingPlayers: ["Bob"],
        },
        waiters: 2,
      },
    ]);
    expect(released(aliceAgain.effects)).toEqual([]);
    expect(released(bobDone.effects)).toEqual([
      {
        result: {
          complete: true,
          completedPlayers: ["Alice", "Bob"],
          pendingPlayers: [],
        },
        waiters: 2,
      },
    ]);
  });

  it("removes an ended session and emits its end exactly once", () => {
    const state = activeSession();
    const cause = { kind: "requested", reason: "done" } as const;
    const first = endSession(state, "0-0", cause, 5);
    const second = endSession(first.state, "0-0", cause, 6);

    expect(first.state.sessions.size).toBe(0);
    expect(first.effects.map((effect) => effect.type)).toEqual(["Ended"]);
    expect(second.effects).toEqual([]);
  });
});

describe("army end logging", () => {
  for (const phase of ["collecting", "active"] as const) {
    it.effect(
      `releases ${phase} waiters and publishes even when log construction throws`,
      () =>
        Effect.gen(function* () {
          const coordinator = yield* makeArmyCoordinator();
          const config = makeConfig(["Alice", "Bob"]);
          const events: ArmySessionEndedEvent[] = [];
          yield* coordinator.onSessionEnded((event) =>
            Effect.sync(() => events.push(event)),
          );
          const joining = yield* coordinator
            .join(config, "Alice", live(1))
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          let waiting: Fiber.Fiber<unknown, unknown> = joining;
          if (phase === "active") {
            const session = yield* coordinator.join(config, "Bob", live(2));
            yield* Fiber.join(joining);
            waiting = yield* coordinator
              .sync(session.sessionId, 1, { step: 0 })
              .pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
          }
          let logAttempts = 0;
          Object.defineProperty(config, "room", {
            get: () => {
              logAttempts += 1;
              throw new Error("Log construction failed");
            },
          });
          const exit = yield* Effect.exit(
            coordinator.abortParticipant(1, {
              kind: "requested",
              reason: "Stop now",
            }),
          );
          yield* Effect.yieldNow;
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(waiting.pollUnsafe()).toMatchObject({ _tag: "Failure" });
          expect(events).toEqual([
            expect.objectContaining({ reason: "Stop now" }),
          ]);
          expect(logAttempts).toBe(1);
          expect(yield* coordinator.getSessions()).toEqual([]);
        }),
    );
  }
});

describe("army timeout diagnostics", () => {
  it.effect(
    "distinguishes absent players from reports that are not ready",
    () => {
      const records: unknown[] = [];
      return Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const config = makeConfig(["Alice", "Bob", "Carol"]);
        const [session] = yield* Effect.all(
          [
            coordinator.join(config, "Alice", live(1)),
            coordinator.join(config, "Bob", live(2)),
            coordinator.join(config, "Carol", live(3)),
          ],
          { concurrency: "unbounded" },
        );
        const alice = yield* coordinator
          .progress(session.sessionId, 1, {
            complete: false,
            label: "farm",
            step: 0,
            timeoutMs: 1_000,
          })
          .pipe(Effect.flip, Effect.forkScoped);
        const bob = yield* coordinator
          .progress(session.sessionId, 2, {
            complete: true,
            label: "farm",
            step: 0,
            timeoutMs: 1_000,
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(alice)).message).toBe(
          "Timed out waiting for army progress 0 (farm); missing: Carol; not ready: Alice",
        );
        expect((yield* Fiber.join(bob)).message).toBe(
          "Timed out waiting for army progress 0 (farm); missing: Carol; not ready: Alice",
        );
        expect(records).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              checkpoints: [
                {
                  arrivedPlayers: ["Alice", "Bob"],
                  kind: "progress",
                  label: "farm",
                  missingPlayers: ["Carol"],
                  notReadyPlayers: ["Alice"],
                  step: 0,
                  timeoutMs: 1_000,
                },
              ],
            }),
          }),
        );
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              records.push(
                options.fiber.getRef(References.CurrentLogAnnotations),
              );
            }),
          ]),
        ),
      );
    },
  );
});
