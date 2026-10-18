import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { clearSessionData } from "./GameSessions";

import {
  defaultGamePartition,
  makeGamePartitionRegistry,
  managedGamePartition,
} from "./GamePartitions";

describe("clearing session data", () => {
  it.effect("clears each distinct session once", () =>
    Effect.gen(function* () {
      const cleared: number[] = [];
      const sessions = Array.from({ length: 12 }, (_, id) => ({
        clearData: async () => {
          cleared.push(id);
        },
      }));
      yield* clearSessionData([...sessions, sessions[0]!]);
      expect(cleared.toSorted((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
    }),
  );

  it.effect(
    "finishes every session and reports all failures with bounded concurrency",
    () =>
      Effect.gen(function* () {
        const attempted: number[] = [];
        const completed: number[] = [];
        const firstFailure = new Error("First profile failed");
        const lastFailure = new Error("Last profile failed");
        let active = 0;
        let peak = 0;
        const sessions = Array.from({ length: 12 }, (_, id) => ({
          clearData: async () => {
            attempted.push(id);
            active += 1;
            peak = Math.max(peak, active);
            try {
              if (id === 0) throw firstFailure;
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (id === 11) throw lastFailure;
              completed.push(id);
            } finally {
              active -= 1;
            }
          },
        }));
        const error = yield* clearSessionData(sessions).pipe(Effect.flip);
        expect(attempted.toSorted((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        ]);
        expect(completed.toSorted((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
        expect(active).toBe(0);
        expect(peak).toBeLessThanOrEqual(4);
        expect(error.cause).toEqual([firstFailure, lastFailure]);
      }),
  );
});

describe("Electron game partition leases", () => {
  it("uses memory sessions for concurrent clients of the same managed account", () => {
    const partitions = makeGamePartitionRegistry({
      makeRandomId: () => "a".repeat(24),
      processId: 42,
    });
    const managed = partitions.acquire({
      kind: "managed-account",
      key: "Alice",
    });
    const duplicate = partitions.acquire({
      kind: "managed-account",
      key: "alice",
    });

    expect(managed).toBe(managedGamePartition("ALICE"));
    expect(duplicate).toBe(`lucent-game-temporary-42-${"a".repeat(24)}`);

    partitions.release(managed);
    expect(
      partitions.acquire({ kind: "managed-account", key: "Alice" }),
    ).toEqual(managed);
  });

  it("persists one default profile and keeps concurrent clients in memory", () => {
    const partitions = makeGamePartitionRegistry({
      makeRandomId: () => "b".repeat(24),
      processId: 42,
    });
    const primary = partitions.acquire({ kind: "default" });
    const concurrent = partitions.acquire({ kind: "default" });

    expect(primary).toBe(defaultGamePartition);
    expect(concurrent).toBe(`lucent-game-temporary-42-${"b".repeat(24)}`);

    partitions.release(primary);
    expect(partitions.acquire({ kind: "default" })).toEqual(primary);
  });
});
