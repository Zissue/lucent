import { describe, expect, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { makeLifetime } from "../../window/RendererLifetimeTesting";

import type { ArmyConfigPayload } from "@lucent/core/army";
import { ArmyIpc } from "../../../shared/ipc";
import { makeListenerRegistry } from "../../app/ListenerRegistry";
import { ArmyConfigRepository } from "../../game/army/ArmyConfigRepository";
import {
  ArmyCoordinator,
  layer as armyCoordinatorLayer,
} from "../../game/army/ArmyCoordinator";
import { ArmyLoopTauntOrchestrator } from "../../game/army/ArmyLoopTauntOrchestrator";
import {
  DesktopWindows,
  type DesktopRendererEvent,
} from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpc, type DesktopIpcMain } from "../DesktopIpc";
import { DesktopIpcSenders, makeDesktopIpcSenders } from "../DesktopIpcSenders";
import { installLifecycle, start } from "./army";

const rendererId = 7;

const soloConfig: ArmyConfigPayload = {
  configName: "solo",
  items: {},
  players: ["Alice"],
  raw: { players: ["Alice"], room: "1234" },
  room: "1234",
  sets: {},
};

const makeGameWindows = () => {
  const lifetimes = new Map([[rendererId, makeLifetime(rendererId)]]);
  const events = makeListenerRegistry<DesktopRendererEvent>();
  const describe: DesktopWindows["Service"]["describe"] = (id) =>
    Effect.sync(() => {
      const lifetime = lifetimes.get(id);
      return lifetime === undefined
        ? undefined
        : {
            rendererId: id,
            kind: "game",
            windowId: id,
            ownerId: undefined,
            generation: lifetime.generation,
            ready: true,
          };
    });
  const lifetime: DesktopWindows["Service"]["lifetime"] = (id) =>
    Effect.sync(() => lifetimes.get(id));
  const identify: DesktopWindows["Service"]["identify"] = (id) =>
    Effect.sync(() => {
      const lifetime = lifetimes.get(id);
      return lifetime === undefined
        ? undefined
        : { rendererId: id, kind: "game", lifetime };
    });
  const observe: DesktopWindows["Service"]["observe"] = (filter, listener) =>
    events.subscribe((event) =>
      filter.kind === undefined || filter.kind === event.kind
        ? listener(event)
        : Effect.void,
    );
  const end = (lifecycle: "closed" | "reloaded" | "crashed") =>
    Effect.gen(function* () {
      const current = lifetimes.get(rendererId)!;
      yield* Scope.close(current.scope, Exit.void);
      const generation = current.generation;
      if (lifecycle === "closed") {
        lifetimes.delete(rendererId);
        yield* events.publish(
          { type: "closed", rendererId, kind: "game", generation },
          "unbounded",
        );
      } else if (lifecycle === "crashed") {
        yield* events.publish(
          {
            type: "crashed",
            rendererId,
            kind: "game",
            generation,
            reason: "crashed",
          },
          "unbounded",
        );
      } else {
        const next = makeLifetime(rendererId, generation + 1);
        lifetimes.set(rendererId, next);
        yield* events.publish(
          {
            type: "reloaded",
            rendererId,
            kind: "game",
            generation: next.generation,
          },
          "unbounded",
        );
      }
    });
  return { describe, end, identify, lifetime, observe };
};

const runStartIpc = <A, E>(
  read: ArmyConfigRepository["Service"]["read"],
  test: (
    windows: ReturnType<typeof makeGameWindows>,
    invokeStart: (configName: string) => Effect.Effect<Fiber.Fiber<unknown>>,
  ) => Effect.Effect<A, E, ArmyCoordinator | Scope.Scope>,
) => {
  const windows = makeGameWindows();
  const handlers = new Map<string, Parameters<DesktopIpcMain["handle"]>[1]>();
  const ipc = makeDesktopIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
    { getAllWebContents: () => [], fromId: () => undefined },
  );
  return Effect.gen(function* () {
    yield* installLifecycle();
    yield* ipc.handle(start);
    const invoke = handlers.get(ArmyIpc.start.channel)!;
    return yield* test(windows, (configName) =>
      Effect.promise(() =>
        invoke({ sender: { id: rendererId } } as IpcMainInvokeEvent, {
          configName,
          playerName: "Alice",
        }),
      ).pipe(Effect.forkChild),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        armyCoordinatorLayer,
        Layer.succeed(DesktopIpc, ipc),
        Layer.mock(DesktopWindows, {
          describe: windows.describe,
          lifetime: windows.lifetime,
          identify: windows.identify,
          observe: windows.observe,
        }),
        Layer.succeed(DesktopIpcSenders, makeDesktopIpcSenders(windows)),
        Layer.succeed(ArmyConfigRepository, { read }),
        Layer.mock(ArmyLoopTauntOrchestrator, {
          onCommand: () => Effect.void,
        }),
      ),
    ),
  );
};

describe("army start IPC", () => {
  for (const lifecycle of ["closed", "reloaded", "crashed"] as const) {
    it.effect(
      `does not seat a game renderer ${lifecycle} while its army config loads`,
      () =>
        Effect.gen(function* () {
          const reading = yield* Deferred.make<void>();
          const released = yield* Deferred.make<ArmyConfigPayload>();
          const read = () =>
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
            );

          yield* runStartIpc(read, (windows, invokeStart) =>
            Effect.gen(function* () {
              const reply = yield* invokeStart("solo");
              yield* Deferred.await(reading);
              yield* windows.end(lifecycle);
              yield* Deferred.succeed(released, soloConfig);
              const envelope = yield* Fiber.join(reply);

              const coordinator = yield* ArmyCoordinator;
              const sessions = yield* coordinator.getSessions();
              expect(
                sessions.map((session) =>
                  Array.from(session.participants.values()),
                ),
              ).toEqual([]);
              expect(envelope).toEqual({
                ok: false,
                error: {
                  channel: "desktop:army:start",
                  code: "IPC_HANDLER_FAILED",
                  message: "Army window is no longer available",
                },
              });
            }),
          );
        }),
    );
  }

  it.effect("keeps the window-closed reason while waiting for the roster", () =>
    runStartIpc(
      () =>
        Effect.succeed({
          ...soloConfig,
          configName: "duo",
          players: ["Alice", "Bob"],
          raw: { players: ["Alice", "Bob"], room: "1234" },
        }),
      (windows, invokeStart) =>
        Effect.gen(function* () {
          const reply = yield* invokeStart("duo");
          const coordinator = yield* ArmyCoordinator;
          const sessions = yield* coordinator.getSessions().pipe(
            Effect.tap(() => Effect.yieldNow),
            Effect.repeat({
              until: (sessions) => sessions.length > 0,
              times: 10,
            }),
          );
          expect(
            sessions.map((session) => ({
              participants: Array.from(session.participants.entries()),
              phase: session.phase,
            })),
          ).toEqual([{ participants: [["alice", 7]], phase: "collecting" }]);

          yield* windows.end("closed");

          expect(yield* Fiber.join(reply)).toEqual({
            ok: false,
            error: {
              channel: "desktop:army:start",
              code: "IPC_HANDLER_FAILED",
              message: "Army window closed",
            },
          });
          expect(yield* coordinator.getSessions()).toEqual([]);
        }),
    ),
  );
});
