import { EventEmitter } from "node:events";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { serveGameRendererRpcPort } from "../../../renderer/apps/game/gameRendererRpc";
import { GameRendererRpcs } from "../../../shared/gameRendererRpc";
import {
  DesktopWindows,
  type DesktopRendererEvent,
} from "../../window/DesktopWindows";
import { makeLifetime } from "../../window/RendererLifetimeTesting";
import {
  makeGameRendererRpc,
  type GameRendererRpcPort,
} from "./GameRendererRpc";

export const TEST_GAME_RENDERER_ID = 42;

export type GameRendererRpcHandlerMap = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof GameRendererRpcs>
>;

const unused = () => Effect.die("Not used by this test.");
const unusedHandlers: GameRendererRpcHandlerMap = {
  EnvironmentFetchBoosts: unused,
  EnvironmentWithdrawBoosts: unused,
  FollowerConfigure: unused,
  FollowerGetState: unused,
  FollowerMe: unused,
  FollowerStart: unused,
  FollowerStop: unused,
  LoaderGrabberGrab: unused,
  LoaderGrabberLoad: unused,
  PacketsSend: unused,
  PacketsStartCapture: unused,
  PacketsStartQueue: unused,
  PacketsStopCapture: unused,
  PacketsStopQueue: unused,
};

type GameListener = (
  event: DesktopRendererEvent,
) => Effect.Effect<void, unknown>;

const toMainPort = (port: MessagePort): GameRendererRpcPort => {
  const events = new EventEmitter();
  port.addEventListener("message", (event) =>
    events.emit("message", { data: event.data, ports: [] }),
  );
  port.addEventListener("close", () => events.emit("close"));
  return Object.assign(events, {
    close: () => port.close(),
    postMessage: (message: unknown) => port.postMessage(message),
    start: () => port.start(),
  });
};

export const makeTestGameRenderer = Effect.fn(function* (
  handlers: Partial<GameRendererRpcHandlerMap> = {},
) {
  const handlerContext = yield* Layer.build(
    GameRendererRpcs.toLayer({ ...unusedHandlers, ...handlers }),
  );
  const runServer = yield* FiberSet.makeRuntime<never, never, never>();
  let server: Fiber.Fiber<never> | undefined;
  let rendererReady = false;
  const listeners = new Set<GameListener>();
  const observe: DesktopWindows["Service"]["observe"] = (filter, listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const filtered: GameListener = (event) =>
          filter.kind === undefined || filter.kind === event.kind
            ? listener(event)
            : Effect.void;
        listeners.add(filtered);
        return filtered;
      }),
      (listener) =>
        Effect.sync(() => {
          listeners.delete(listener);
        }),
    ).pipe(Effect.asVoid);
  const windows = {
    getOwnedRendererIds: (rendererId: number) =>
      Effect.succeed([rendererId + 100]),
    describe: (rendererId: number) =>
      Effect.sync(() => ({
        rendererId,
        kind: "game",
        windowId: 1,
        ownerId: undefined,
        lifetime: makeLifetime(rendererId),
        ready: rendererReady,
      })),
    observe,
  } as unknown as DesktopWindows["Service"];
  const emit = (type: "ready" | "reloaded") =>
    Effect.forEach(
      listeners,
      (listener) =>
        listener({
          type,
          generation: 1,
          kind: "game",
          rendererId: TEST_GAME_RENDERER_ID,
        }).pipe(Effect.orDie),
      { discard: true },
    );

  const rpc = yield* makeGameRendererRpc({
    open: () => {
      const { port1, port2 } = new MessageChannel();
      server = runServer(
        serveGameRendererRpcPort(port2).pipe(
          Effect.provideContext(handlerContext),
        ),
      );
      return toMainPort(port1);
    },
  }).pipe(Effect.provideService(DesktopWindows, windows));

  return {
    ready: Effect.suspend(() => {
      rendererReady = true;
      return emit("ready");
    }),
    reload: Effect.suspend(() => {
      rendererReady = false;
      return emit("reloaded");
    }),
    rpc,
    stopRenderer: Effect.suspend(() =>
      server === undefined ? Effect.void : Fiber.interrupt(server),
    ),
    windows,
  };
});
