import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeLifetime } from "../../window/RendererLifetimeTesting";
import type { GameViewHostState } from "../../../shared/gameViews";
import { ElectronDialog } from "../../electron/ElectronDialog";
import { Accounts } from "../../game/accounts/Accounts";
import {
  AccountSessions,
  layer as sessionsLayer,
} from "../../game/accounts/AccountSessions";
import {
  DesktopWindowError,
  DesktopWindows,
  type GameViewHostChange,
} from "../../window/DesktopWindows";
import {
  close,
  closeCurrent,
  reopen,
  select,
  reorder,
  setLayout,
  setGroupControlsOpen,
  setTabMenuOpen,
  setGroupTargets,
  syncTabBarLayout,
  dispatchGroupOptionHotkey,
} from "./gameViews";
import { DesktopIpc } from "../DesktopIpc";

const hostState: GameViewHostState = {
  capacity: 7,
  groupControlsOpen: false,
  groupTargetIds: [],
  layout: "focused",
  selectedId: "42",
  sessions: [{ id: "42", name: "Alice", phase: "ready" }],
};
const sender = {
  kind: "game-host",
  rendererId: 100,
  lifetime: makeLifetime(100, 1),
} as const;

describe("game view lifecycle IPC", () => {
  it.effect("keeps running scripts open until close is confirmed", () =>
    Effect.gen(function* () {
      const sessions = yield* AccountSessions;
      sessions.openWindow(77, 1, 1);
      sessions.openWindow(42, 1, 1);
      sessions.applyReport(42, {
        rendererGeneration: 1,
        revision: 1,
        runtime: {
          connection: { state: "online", username: "Alice" },
          login: { state: "idle" },
          script: { state: "running", name: "farm.js" },
        },
      });
      let response = 0;
      const closed: number[] = [];
      const parents: (number | undefined)[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(ElectronDialog, {
          showMessageBox: (_options, parentId) =>
            Effect.sync(() => {
              parents.push(parentId);
              return { response, checkboxChecked: false };
            }),
        }),
        Layer.mock(DesktopWindows, {
          getGameViewHostState: () => Effect.succeed(hostState),
          describe: (rendererId) =>
            Effect.succeed({
              rendererId,
              kind: rendererId === 100 ? "game-host" : "game",
              windowId: 1,
              ownerId: undefined,
              lifetime: makeLifetime(rendererId),
              ready: false,
            }),
          closeGameView: (_hostId, id) =>
            Effect.sync(() => {
              closed.push(id);
              sessions.closeWindow(42, 50);
            }),
        }),
      );
      yield* close
        .handler({ id: "42" }, sender)
        .pipe(Effect.provide(dependencies));
      expect(
        sessions
          .snapshot()
          .map((session) => session.gameWindowId)
          .toSorted((a, b) => a - b),
      ).toEqual([42, 77]);
      expect(sessions.recentlyClosed(1)).toEqual([]);
      response = 1;
      yield* close
        .handler({ id: "42" }, sender)
        .pipe(Effect.provide(dependencies));
      expect(closed).toEqual([42]);
      expect(parents).toEqual([1, 1]);
      expect(sessions.recentlyClosed(1)).toEqual([
        {
          id: 42,
          closedAt: 50,
          username: "Alice",
        },
      ]);
    }).pipe(Effect.provide(sessionsLayer)),
  );

  it.effect(
    "closes the current client without confirming a running script",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AccountSessions;
        sessions.openWindow(77, 1, 1);
        sessions.openWindow(42, 1, 1);
        sessions.applyReport(42, {
          rendererGeneration: 1,
          revision: 1,
          runtime: {
            connection: { state: "online", username: "Alice" },
            login: { state: "idle" },
            script: { state: "running", name: "farm.js" },
          },
        });
        const dependencies = Layer.mock(DesktopWindows, {
          closeRenderer: (id) =>
            Effect.sync(() => sessions.closeWindow(id, 50)),
        });
        yield* closeCurrent
          .handler(undefined, {
            kind: "game",
            rendererId: 42,
            lifetime: makeLifetime(42, 1),
          })
          .pipe(Effect.provide(dependencies));
        expect(
          sessions.snapshot().map((session) => session.gameWindowId),
        ).toEqual([77]);
      }).pipe(Effect.provide(sessionsLayer)),
  );

  it.effect(
    "rejects reopening at seven tabs and targets the requesting window when space exists",
    () =>
      Effect.gen(function* () {
        let count = 7;
        const reopened: unknown[] = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(DesktopWindows, {
            getGameViewHostState: () =>
              Effect.succeed({
                ...hostState,
                sessions: Array.from({ length: count }, (_, index) => ({
                  id: String(index + 42),
                  name: "Tab",
                  phase: "ready" as const,
                })),
              }),
            describe: (rendererId) =>
              Effect.succeed({
                rendererId,
                kind: rendererId === 100 ? "game-host" : "game",
                windowId: 1,
                ownerId: undefined,
                lifetime: makeLifetime(rendererId),
                ready: false,
              }),
          }),
          Layer.mock(Accounts, {
            reopenGameWindow: (request) =>
              Effect.sync(() => {
                reopened.push(request);
                count += 1;
                return { gameWindowId: 43 };
              }),
          }),
        );
        const error = yield* Effect.flip(
          reopen.handler({ id: 9 }, sender).pipe(Effect.provide(dependencies)),
        );
        expect(error.message).toBe("Close a tab before reopening another.");
        count = 6;
        const state = yield* reopen
          .handler({ id: 9 }, sender)
          .pipe(Effect.provide(dependencies));
        expect(state).toHaveProperty("sessions.length", 7);
        expect(reopened).toEqual([
          {
            id: 9,
            gameWindowGroupId: 1,
            windowTarget: { kind: "same-as-game", gameWindowId: 42 },
          },
        ]);
      }),
  );
});

describe("game view host command IPC", () => {
  it.effect(
    "decodes tab ids and preserves each command's result contract",
    () =>
      Effect.gen(function* () {
        const changes: [number, GameViewHostChange][] = [];
        const dependencies = Layer.mock(DesktopWindows, {
          updateGameViewHost: (id, change) =>
            Effect.sync(() => {
              changes.push([id, change]);
              return hostState;
            }),
        });
        const run = <A, E>(effect: Effect.Effect<A, E, DesktopWindows>) =>
          effect.pipe(Effect.provide(dependencies));
        expect(
          yield* run(select.handler({ id: "42", focus: "view" }, sender)),
        ).toEqual(hostState);
        expect(yield* run(reorder.handler({ ids: ["42"] }, sender))).toEqual(
          hostState,
        );
        expect(
          yield* run(setLayout.handler({ layout: "grid" }, sender)),
        ).toEqual(hostState);
        expect(
          yield* run(
            setGroupControlsOpen.handler(
              { open: true },
              {
                kind: "game-group-controls",
                rendererId: 101,
                lifetime: makeLifetime(101, 1),
              },
            ),
          ),
        ).toEqual(hostState);
        expect(
          yield* run(setGroupTargets.handler({ ids: ["42"] }, sender)),
        ).toEqual(hostState);
        expect(yield* run(setTabMenuOpen.handler({ open: true }, sender))).toBe(
          true,
        );
        expect(
          yield* run(setTabMenuOpen.handler({ open: false }, sender)),
        ).toBe(false);
        expect(
          yield* run(syncTabBarLayout.handler(undefined, sender)),
        ).toBeUndefined();
        expect(changes).toEqual([
          [100, { type: "select", id: 42, focus: "view" }],
          [100, { type: "reorder", ids: [42] }],
          [100, { type: "layout", layout: "grid" }],
          [101, { type: "group-controls", open: true }],
          [100, { type: "group-targets", ids: [42] }],
          [100, { type: "tab-menu", open: true }],
          [100, { type: "tab-menu", open: false }],
          [100, { type: "tab-bar-layout" }],
        ]);
        const error = new DesktopWindowError({
          id: "100",
          detail: "Failed to update the tab menu.",
        });
        expect(
          yield* setTabMenuOpen.handler({ open: true }, sender).pipe(
            Effect.provide(
              Layer.mock(DesktopWindows, {
                updateGameViewHost: () => Effect.fail(error),
              }),
            ),
            Effect.flip,
          ),
        ).toBe(error);
      }),
  );

  it.effect("resolves a group hotkey's host using the requesting tab", () =>
    Effect.gen(function* () {
      const queried: number[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(DesktopWindows, {
          getGameViewHostState: (id) =>
            Effect.sync(() => {
              queried.push(id);
              return hostState;
            }),
        }),
        Layer.mock(DesktopIpc, {}),
      );
      expect(
        yield* dispatchGroupOptionHotkey
          .handler(
            { commandId: "toggleInfiniteRange" },
            {
              kind: "game",
              rendererId: 42,
              lifetime: makeLifetime(42, 1),
            },
          )
          .pipe(Effect.provide(dependencies)),
      ).toEqual({ recipientCount: 0, skippedCount: 0, status: "sent" });
      expect(queried).toEqual([42]);
    }),
  );
});
