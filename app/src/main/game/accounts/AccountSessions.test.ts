import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { AccountSessionReport } from "@lucent/core/accounts";
import { AccountSessions, layer } from "./AccountSessions";

const report = (
  rendererGeneration: number,
  revision: number,
  username: string,
): AccountSessionReport => ({
  rendererGeneration,
  revision,
  runtime: {
    connection: { state: "online", username },
    login: { state: "idle" },
    script: { state: "idle" },
  },
});

describe("AccountSessions", () => {
  it.effect(
    "timestamps synchronous session transitions with the captured clock",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        yield* TestClock.setTime(1000);
        sessions.openWindow(42, 7, 1);
        expect(sessions.snapshot()[0]?.updatedAt).toBe(1000);
        yield* TestClock.setTime(2000);
        sessions.trackLaunch(42, 7, 1, {
          account: { label: "Alice", password: "secret", username: "Alice" },
          requestedAt: 1500,
        });
        expect(sessions.snapshot()[0]?.updatedAt).toBe(2000);
        yield* TestClock.setTime(3000);
        sessions.suppressLaunchScript(42, "Missing script");
        expect(sessions.snapshot()[0]?.updatedAt).toBe(3000);
        yield* TestClock.setTime(4000);
        sessions.reloadWindow(42, 7, 2);
        expect(sessions.snapshot()[0]?.updatedAt).toBe(4000);
        yield* TestClock.setTime(5000);
        sessions.applyReport(42, report(2, 1, "Alice"));
        expect(sessions.snapshot()[0]?.updatedAt).toBe(5000);
        yield* TestClock.setTime(6000);
        sessions.openWindow(77, 7, 1);
        expect(
          sessions.snapshot().map(({ gameWindowId, updatedAt }) => ({
            gameWindowId,
            updatedAt,
          })),
        ).toEqual([
          { gameWindowId: 77, updatedAt: 6000 },
          { gameWindowId: 42, updatedAt: 5000 },
        ]);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("accepts session changes and ignores stale mutations", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      expect(sessions.openWindow(42, 7, 1)).toBe(true);
      expect(sessions.openWindow(42, 7, 1)).toBe(false);
      expect(sessions.reloadWindow(42, 7, 1)).toBe(false);
      expect(sessions.applyReport(42, report(2, 1, "Alice"))).toBeNull();
      expect(sessions.suppressLaunchScript(99, "Missing script")).toBe(false);
      expect(sessions.remove(99)).toBe(false);
      expect(sessions.applyReport(42, report(1, 1, "Alice"))).toEqual({
        windowName: "Alice",
      });
      expect(sessions.applyReport(42, report(1, 1, "Bob"))).toBeNull();
      expect(sessions.openWindow(42, 7, 2)).toBe(true);
      expect(
        sessions.trackLaunch(42, 7, 1, {
          account: { label: "Alice", password: "secret", username: "Alice" },
          requestedAt: 10,
        }),
      ).toBe(false);
      expect(
        sessions.trackLaunch(42, 7, 2, {
          account: { label: "Alice", password: "secret", username: "Alice" },
          requestedAt: 10,
        }),
      ).toBe(true);
      expect(sessions.suppressLaunchScript(42, "Missing script")).toBe(true);
      expect(sessions.snapshot()[0]?.script).toEqual({
        state: "failed",
        message: "Missing script",
      });
      expect(sessions.closeWindow(42, 20)).toBe(true);
      expect(sessions.closeWindow(42, 30)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("forgets closed history without changing open sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(77, 7, 1);
      sessions.trackLaunch(42, 7, 1, {
        account: { label: "Alice", password: "secret", username: "Alice" },
        requestedAt: 10,
      });
      sessions.closeWindow(42, 20);
      expect(sessions.recentlyClosed(7)).toEqual([
        { id: 42, closedAt: 20, username: "Alice" },
      ]);
      sessions.forgetClosed(42);
      expect(sessions.recentlyClosed(7)).toEqual([]);
      expect(
        sessions.snapshot().map((session) => session.gameWindowId),
      ).toEqual([77]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "remembers login intent without retaining credentials or scripts",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        sessions.openWindow(77, 7, 1);
        sessions.trackLaunch(42, 7, 1, {
          account: { label: "Alice", password: "secret", username: "Alice" },
          requestedAt: 10,
          server: "Artix",
          script: { name: "farm.js", path: "/scripts/farm.js" },
        });
        sessions.closeWindow(42, 20);
        sessions.closeWindow(42, 30);
        expect(sessions.recentlyClosed(7)).toEqual([
          { id: 42, closedAt: 20, username: "Alice", server: "Artix" },
        ]);
        expect(
          sessions.snapshot().map((session) => session.gameWindowId),
        ).toEqual([77]);
        expect(sessions.getLaunch(42)).toBeNull();
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "remembers the last played account instead of an earlier launch",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        sessions.openWindow(77, 7, 1);
        sessions.trackLaunch(42, 7, 1, {
          account: { label: "Alice", password: "secret", username: "Alice" },
          requestedAt: 10,
          server: "Artix",
        });
        sessions.applyReport(42, report(1, 1, "Bob"));
        sessions.applyReport(42, {
          rendererGeneration: 1,
          revision: 2,
          runtime: {
            connection: { state: "offline", lastUsername: "Bob" },
            login: { state: "idle" },
            script: { state: "idle" },
          },
        });
        sessions.closeWindow(42, 20);
        expect(sessions.recentlyClosed(7)).toEqual([
          { id: 42, closedAt: 20, username: "Bob" },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps five accounts in newest-first order and consumes only the reopened entry",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        sessions.openWindow(77, 7, 1);
        for (let id = 1; id <= 7; id += 1) {
          sessions.openWindow(id, 7, 1);
          sessions.applyReport(id, report(1, 1, `Player ${id}`));
          sessions.closeWindow(id, id * 10);
        }
        expect(sessions.recentlyClosed(7).map((entry) => entry.id)).toEqual([
          7, 6, 5, 4, 3,
        ]);
        expect(sessions.recentlyClosed(7)[0]).toEqual({
          id: 7,
          closedAt: 70,
          username: "Player 7",
        });
        sessions.forgetClosed(5);
        expect(sessions.recentlyClosed(7).map((entry) => entry.id)).toEqual([
          7, 6, 4, 3,
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "coalesces account names within a window and clears only a closed window's history",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        sessions.openWindow(77, 7, 1);
        sessions.openWindow(88, 8, 1);
        for (const [id, groupId, username, server] of [
          [1, 7, "Alice", "Artix"],
          [2, 7, "Bob", "Artix"],
          [3, 8, "ALICE", "Yorumi"],
          [4, 7, "alice", "Yorumi"],
        ] as const) {
          sessions.trackLaunch(id, groupId, 1, {
            account: { username, password: "secret", label: username },
            requestedAt: 0,
            server,
          });
          sessions.closeWindow(id, id * 10);
        }
        expect(sessions.recentlyClosed(7)).toEqual([
          { id: 4, closedAt: 40, username: "alice", server: "Yorumi" },
          { id: 2, closedAt: 20, username: "Bob", server: "Artix" },
        ]);
        expect(sessions.recentlyClosed(8)).toEqual([
          { id: 3, closedAt: 30, username: "ALICE", server: "Yorumi" },
        ]);
        sessions.openWindow(5, 7, 1);
        sessions.closeWindow(5, 50);
        expect(
          sessions.recentlyClosed(7).map((entry) => entry.username),
        ).toEqual(["alice", "Bob"]);
        sessions.closeWindow(77, 60);
        expect(sessions.recentlyClosed(7)).toEqual([]);
        expect(
          sessions.recentlyClosed(8).map((entry) => entry.username),
        ).toEqual(["ALICE"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("does not treat launch intent as an online identity", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(42, 7, 1);
      sessions.trackLaunch(42, 7, 1, {
        account: { label: "Alice", password: "secret", username: "Alice" },
        requestedAt: 10,
      });

      expect(sessions.snapshot()[0]).toMatchObject({
        connection: { state: "offline" },
        launch: { username: "Alice" },
        login: { state: "waiting-for-game" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores reports older than the accepted renderer revision", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(42, 7, 1);

      expect(sessions.applyReport(42, report(1, 2, "Bob"))).not.toBeNull();
      expect(sessions.applyReport(42, report(1, 1, "Alice"))).toBeNull();
      expect(sessions.snapshot()[0]?.connection).toEqual({
        state: "online",
        username: "Bob",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("uses renderer reload as an ordering barrier", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(42, 7, 1);
      sessions.applyReport(42, report(1, 5, "Alice"));
      sessions.reloadWindow(42, 7, 2);

      expect(sessions.applyReport(42, report(1, 6, "Alice"))).toBeNull();
      expect(sessions.applyReport(42, report(2, 1, "Bob"))).not.toBeNull();
      expect(sessions.snapshot()[0]?.connection).toEqual({
        state: "online",
        username: "Bob",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not recreate a closed window from a late report", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(42, 7, 1);
      sessions.remove(42);

      expect(sessions.applyReport(42, report(1, 1, "Alice"))).toBeNull();
      expect(sessions.snapshot()).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not roll a reloaded window back for an old launch", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(42, 7, 1);
      sessions.reloadWindow(42, 7, 2);
      sessions.trackLaunch(42, 7, 1, {
        account: { label: "Alice", password: "secret", username: "Alice" },
        requestedAt: 10,
      });

      expect(sessions.snapshot()[0]).toMatchObject({
        rendererGeneration: 2,
      });
      expect(sessions.snapshot()[0]).not.toHaveProperty("launch");
    }).pipe(Effect.provide(layer)),
  );
});
