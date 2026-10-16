import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";

import { GameRendererRpcs } from "../../../shared/gameRendererRpc";
import { GAME_RENDERER_RPC_PORT_MESSAGE } from "../../../shared/ipc/gameRenderer";

export type GameRendererRpcHandlers = Rpc.ToHandler<
  RpcGroup.Rpcs<typeof GameRendererRpcs>
>;

const makeProtocol = (port: MessagePort) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const run = yield* FiberSet.makeRuntime<never, void>();
      const onMessage = (event: MessageEvent) => {
        run(writeRequest(0, event.data));
      };
      port.addEventListener("message", onMessage);
      port.start();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          port.removeEventListener("message", onMessage);
          port.close();
        }),
      );
      return {
        disconnects: yield* Queue.make<number>(),
        send: (_clientId, response) =>
          Effect.sync(() => port.postMessage(response)),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: Schema.toCodecJson,
      };
    }),
  );

export const serveGameRendererRpcPort = (port: MessagePort) =>
  RpcServer.make(GameRendererRpcs, {
    disableFatalDefects: true,
    disableTracing: true,
  }).pipe(
    Effect.provideServiceEffect(RpcServer.Protocol, makeProtocol(port)),
    Effect.scoped,
  );

export const serveGameRendererRpc = <R>(
  handlers: Layer.Layer<GameRendererRpcHandlers, never, R>,
  onListening: () => void,
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(handlers);
    const run = yield* FiberHandle.makeRuntime<never, never, never>();
    const onMessage = (event: MessageEvent) => {
      const [port] = event.ports;
      if (
        event.source !== window ||
        event.data !== GAME_RENDERER_RPC_PORT_MESSAGE ||
        port === undefined
      ) {
        return;
      }
      run(serveGameRendererRpcPort(port).pipe(Effect.provideContext(context)));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("message", onMessage)),
      () => Effect.sync(() => window.removeEventListener("message", onMessage)),
    );
    onListening();
    return yield* Effect.never;
  }).pipe(Effect.scoped);
