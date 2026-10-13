import { describe, expect, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type { ArmyConfigPayload } from "@lucent/core/army";
import { ArmyIpc } from "../../../shared/ipc";
import { makeListenerRegistry } from "../../app/ListenerRegistry";
import { ArmyConfigRepository } from "../../internal/army/ArmyConfigRepository";
import {
  ArmyCoordinator,
  layer as armyCoordinatorLayer,
} from "../../internal/army/ArmyCoordinator";
import { ArmyLoopTauntOrchestrator } from "../../internal/army/ArmyLoopTauntOrchestrator";
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
  const generations = new Map<number, number>([[rendererId, 1]]);
  const events = makeListenerRegistry<DesktopRendererEvent>();
  const describe: DesktopWindows["Service"]["describe"] = (id) =>
    Effect.sync(() => {
      const generation = generations.get(id);
      return generation === undefined
        ? undefined
        : {
            rendererId: id,
            kind: "game",
            windowId: id,
            ownerId: undefined,
            generation,
            ready: true,
          };
    });
  const observe: DesktopWindows["Service"]["observe"] = (filter, listener) =>
    Effect.acquireRelease(
      events.subscribe((event) =>
        filter.kind === undefined || filter.kind === event.kind
          ? listener(event)
          : Effect.void,
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid);
  const end = (lifecycle: "closed" | "reloaded") =>
    Effect.suspend(() => {
      if (lifecycle === "closed") {
        generations.delete(rendererId);
        return events.publish(
          { type: "closed", rendererId, kind: "game" },
          "unbounded",
        );
      }
      const generation = generations.get(rendererId)! + 1;
      generations.set(rendererId, generation);
      return events.publish(
        { type: "reloaded", rendererId, kind: "game", generation },
        "unbounded",
      );
    });
  return { describe, end, observe };
};

const makeIpcMain = () => {
  const handlers = new Map<string, Parameters<DesktopIpcMain["handle"]>[1]>();
  const main: DesktopIpcMain = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return { handlers, main };
};

describe("army start IPC", () => {
  for (const lifecycle of ["closed", "reloaded"] as const) {
    it.effect(
      `does not seat a game renderer ${lifecycle} while its army config loads`,
      () =>
        Effect.gen(function* () {
          const reading = yield* Deferred.make<void>();
          const released = yield* Deferred.make<ArmyConfigPayload>();
          const windows = makeGameWindows();
          const { handlers, main } = makeIpcMain();
          const ipc = makeDesktopIpc(main, {
            getAllWebContents: () => [],
            fromId: () => undefined,
          });

          yield* Effect.gen(function* () {
            yield* installLifecycle();
            yield* ipc.handle(start);
            const invoke = handlers.get(ArmyIpc.start.channel)!;
            const reply = yield* Effect.promise(() =>
              invoke({ sender: { id: rendererId } } as IpcMainInvokeEvent, {
                configName: "solo",
                playerName: "Alice",
              }),
            ).pipe(Effect.forkChild);

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
            expect(envelope).toMatchObject({ ok: false });
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                armyCoordinatorLayer,
                Layer.succeed(DesktopIpc, ipc),
                Layer.mock(DesktopWindows, {
                  describe: windows.describe,
                  observe: windows.observe,
                }),
                Layer.succeed(
                  DesktopIpcSenders,
                  makeDesktopIpcSenders(windows),
                ),
                Layer.succeed(ArmyConfigRepository, {
                  read: () =>
                    Deferred.succeed(reading, undefined).pipe(
                      Effect.andThen(Deferred.await(released)),
                    ),
                }),
                Layer.mock(ArmyLoopTauntOrchestrator, {
                  onCommand: () => Effect.succeed(() => {}),
                }),
              ),
            ),
          );
        }),
    );
  }
});
