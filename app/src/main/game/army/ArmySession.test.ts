import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";

import type { ArmyConfigPayload } from "@lucent/core/army";
import {
  arriveAtStep,
  endSession,
  initialCoordinatorState,
  joinSession,
  type ArmyCoordinatorState,
} from "./ArmySession";

const makeConfig = (players: readonly string[]): ArmyConfigPayload => ({
  configName: "test",
  items: {},
  players,
  raw: { players, room: "1234" },
  room: "1234",
  sets: {},
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
