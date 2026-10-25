import { describe, expect, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { makeLifetime } from "../window/RendererLifetimeTesting";
import { DesktopWindows } from "../window/DesktopWindows";
import { defineEvent, defineInvoke } from "../../shared/ipc";
import {
  DesktopIpcRegistrationError,
  makeDesktopIpc,
  makeDesktopIpcMethod,
  type DesktopIpcMain,
  type DesktopIpcWebContents,
} from "./DesktopIpc";

const descriptor = defineInvoke({
  channel: "desktop:test:echo",
  payload: Schema.String,
  result: Schema.String,
});

const eventDescriptor = defineEvent({
  channel: "desktop:test:event",
  payload: Schema.String,
});

const method = makeDesktopIpcMethod({
  descriptor,
  allowedSenders: ["game"],
  handler: (payload, sender) =>
    Effect.succeed(`${payload}:${sender.rendererId}`),
});

const windows = Layer.mock(DesktopWindows, {
  describe: (rendererId) =>
    Effect.succeed({
      rendererId,
      kind: "game",
      windowId: 1,
      ownerId: undefined,
      lifetime: makeLifetime(rendererId, 1),
      ready: true,
    }),
});

const makeIpcMain = () => {
  const handlers = new Map<string, Parameters<DesktopIpcMain["handle"]>[1]>();
  const main: DesktopIpcMain = {
    handle: (channel, listener) => {
      if (handlers.has(channel)) {
        throw new Error(`Handler already registered: ${channel}`);
      }
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  return { handlers, main };
};

describe("DesktopIpc", () => {
  it.effect("runs a typed method with its resolved sender", () =>
    Effect.gen(function* () {
      const { handlers, main } = makeIpcMain();
      const ipc = makeDesktopIpc(main);
      yield* ipc.handle(method);
      const listener = handlers.get(descriptor.channel);

      expect(listener).toBeDefined();
      const envelope = yield* Effect.promise(() =>
        listener!({ sender: { id: 42 } } as IpcMainInvokeEvent, "hello"),
      );

      expect(envelope).toEqual({ ok: true, value: "hello:42" });
    }).pipe(Effect.provide(windows)),
  );

  it.effect(
    "fails duplicate handler registration instead of replacing it",
    () =>
      Effect.gen(function* () {
        const { main } = makeIpcMain();
        const ipc = makeDesktopIpc(main);
        yield* ipc.handle(method);

        const error = yield* Effect.flip(ipc.handle(method));

        expect(error).toBeInstanceOf(DesktopIpcRegistrationError);
        expect(error.channel).toBe(descriptor.channel);
      }).pipe(Effect.provide(windows)),
  );

  it.effect("continues delivery after a destroyed-renderer race", () =>
    Effect.gen(function* () {
      const { main } = makeIpcMain();
      const delivered: string[] = [];
      let destroyed = false;
      const raced: DesktopIpcWebContents = {
        isDestroyed: () => destroyed,
        send: () => {
          destroyed = true;
          throw new Error("Renderer closed during delivery.");
        },
      };
      const receiving: DesktopIpcWebContents = {
        isDestroyed: () => false,
        send: (_channel, payload) => {
          delivered.push(String(payload));
        },
      };
      const ipc = makeDesktopIpc(main, {
        getAllWebContents: () => [raced, receiving],
        fromId: () => undefined,
      });
      yield* ipc.sendToAll(eventDescriptor, "hello");
      expect(delivered).toEqual(["hello"]);
    }),
  );

  it.effect(
    "reports unexpected failures after attempting every recipient",
    () =>
      Effect.gen(function* () {
        const { main } = makeIpcMain();
        const delivered: string[] = [];
        const failing: DesktopIpcWebContents = {
          isDestroyed: () => false,
          send: () => {
            throw new Error("Unexpected IPC transport failure.");
          },
        };
        const receiving: DesktopIpcWebContents = {
          isDestroyed: () => false,
          send: (_channel, payload) => {
            delivered.push(String(payload));
          },
        };
        const ipc = makeDesktopIpc(main, {
          getAllWebContents: () => [failing, receiving],
          fromId: () => undefined,
        });
        const exit = yield* Effect.exit(
          ipc.sendToAll(eventDescriptor, "hello"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            message: "Unexpected IPC transport failure.",
          });
        expect(delivered).toEqual(["hello"]);
      }),
  );

  it.effect("broadcasts to owned detached views and targets renderer ids", () =>
    Effect.gen(function* () {
      const { main } = makeIpcMain();
      const delivered: string[] = [];
      const view: DesktopIpcWebContents = {
        isDestroyed: () => false,
        send: (_channel, payload) => {
          delivered.push(`view:${String(payload)}`);
        },
      };
      const host: DesktopIpcWebContents = {
        isDestroyed: () => false,
        send: (_channel, payload) => {
          delivered.push(`host:${String(payload)}`);
        },
      };
      const ipc = makeDesktopIpc(main, {
        getAllWebContents: () => [host, view],
        fromId: (id) => (id === 42 ? view : undefined),
      });
      yield* ipc.sendToAll(eventDescriptor, "all");
      yield* ipc.sendToRendererIds([42, 404], eventDescriptor, "target");
      expect(delivered).toEqual(["host:all", "view:all", "view:target"]);
    }),
  );
});
