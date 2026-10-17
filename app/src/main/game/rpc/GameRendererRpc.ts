import { MessageChannelMain, type MessagePortMain } from "electron";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";

import { GameRendererRpcs } from "../../../shared/gameRendererRpc";
import { GAME_RENDERER_RPC_PORT_CHANNEL } from "../../../shared/ipc";
import { electronRendererRegistry } from "../../electron/ElectronRendererRegistry";
import { DesktopWindows } from "../../window/DesktopWindows";

export type GameRendererRpcClient = RpcClient.FromGroup<
  typeof GameRendererRpcs,
  RpcClientError
>;

export type GameRendererRpcPort = Pick<
  MessagePortMain,
  "close" | "off" | "on" | "postMessage" | "start"
>;

export interface GameRendererRpcTransport {
  readonly open: (rendererId: number) => GameRendererRpcPort | undefined;
}

export class GameRendererUnavailableError extends Schema.TaggedError<GameRendererUnavailableError>()(
  "GameRendererUnavailableError",
  {
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface GameRendererRpcShape {
  readonly call: <A, E>(
    gameRendererId: number,
    request: (
      client: GameRendererRpcClient,
    ) => Effect.Effect<A, E | RpcClientError>,
    options: { readonly timeout: Duration.Input },
  ) => Effect.Effect<
    A,
    Exclude<E, RpcClientError> | GameRendererUnavailableError
  >;
  readonly onConnected: (
    listener: (gameRendererId: number) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

export class GameRendererRpc extends Context.Service<
  GameRendererRpc,
  GameRendererRpcShape
>()("lucent/desktop/game/rpc/GameRendererRpc") {}

interface Connection {
  readonly client: GameRendererRpcClient;
  readonly close: Effect.Effect<void>;
}

const isRpcClientError = Schema.is(RpcClientError);

class GameRendererRpcClientError extends RpcClientError {
  override get cause(): RpcClientError["reason"] {
    return this.reason;
  }
}

const makePortProtocol = Effect.fnUntraced(function* (
  port: GameRendererRpcPort,
) {
  const run = yield* FiberSet.makeRuntime<never, void>();
  let disconnect: Effect.Effect<void> = Effect.void;
  const protocol = yield* RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      let failure: RpcClientError | undefined;
      disconnect = Effect.suspend(() => {
        if (failure !== undefined) {
          return Effect.void;
        }
        failure = new GameRendererRpcClientError({
          reason: new RpcClientDefect({
            message: "The connection was closed.",
            cause: undefined,
          }),
        });
        const response = {
          _tag: "ClientProtocolError" as const,
          error: failure,
        };
        return Effect.forEach(
          clientIds,
          (clientId) => writeResponse(clientId, response),
          { discard: true },
        );
      });
      const onMessage = (event: Electron.MessageEvent) => {
        run(
          Effect.forEach(
            clientIds,
            (clientId) => writeResponse(clientId, event.data),
            { discard: true },
          ),
        );
      };
      const onClose = () => {
        run(disconnect);
      };
      port.on("message", onMessage);
      port.on("close", onClose);
      port.start();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          port.off("message", onMessage);
          port.off("close", onClose);
          port.close();
        }),
      );
      return {
        send: (_clientId, request) =>
          failure !== undefined
            ? Effect.fail(failure)
            : Effect.try({
                try: () => port.postMessage(request),
                catch: (cause) =>
                  new GameRendererRpcClientError({
                    reason: new RpcClientDefect({
                      message: "Could not send the request.",
                      cause,
                    }),
                  }),
              }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
  return { disconnect: Effect.suspend(() => disconnect), protocol };
});

export const makeGameRendererRpc = Effect.fn("makeGameRendererRpc")(function* (
  transport: GameRendererRpcTransport,
) {
  const windows = yield* DesktopWindows;
  const scope = yield* Effect.scope;
  const connections = new Map<number, Connection>();
  const connectedListeners = new Set<
    (gameRendererId: number) => Effect.Effect<void>
  >();

  const disconnect = (rendererId: number) =>
    Effect.suspend(() => {
      const connection = connections.get(rendererId);
      if (connection === undefined) {
        return Effect.void;
      }
      connections.delete(rendererId);
      return connection.close;
    });

  const connect = Effect.fn("GameRendererRpc.connect")(function* (
    rendererId: number,
  ) {
    yield* disconnect(rendererId);
    const port = yield* Effect.try({
      try: () => transport.open(rendererId),
      catch: (cause) =>
        new GameRendererUnavailableError({
          detail: "The connection was unavailable.",
          cause,
        }),
    });
    if (port === undefined) {
      return;
    }

    const connectionScope = yield* Scope.fork(scope);
    const { disconnect: failRequests, protocol } = yield* makePortProtocol(
      port,
    ).pipe(Scope.provide(connectionScope));
    const client = yield* RpcClient.make(GameRendererRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.provide(connectionScope),
    );
    connections.set(rendererId, {
      client,
      close: failRequests.pipe(
        Effect.andThen(Scope.close(connectionScope, Exit.void)),
      ),
    });
    yield* Effect.forEach(
      connectedListeners,
      (listener) => listener(rendererId),
      { discard: true },
    );
  });

  const call: GameRendererRpcShape["call"] = (
    gameRendererId,
    request,
    options,
  ) =>
    Effect.catchIf(
      Effect.gen(function* () {
        const rendererReady =
          (yield* windows.describe(gameRendererId))?.ready ?? false;
        const connection = connections.get(gameRendererId);
        if (!rendererReady || connection === undefined) {
          return yield* new GameRendererUnavailableError({
            detail: "The game is still loading. Try again in a moment.",
          });
        }
        return yield* request(connection.client);
      }),
      isRpcClientError,
      (cause) =>
        Effect.fail(
          new GameRendererUnavailableError({
            detail: "The connection was unavailable.",
            cause,
          }),
        ),
      Effect.fail,
    ).pipe(
      Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
        Effect.fail(
          new GameRendererUnavailableError({
            detail: "The connection was unavailable.",
          }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () =>
          Effect.fail(
            new GameRendererUnavailableError({
              detail: "The game did not respond in time. Try again.",
            }),
          ),
      }),
    );

  const onConnected: GameRendererRpcShape["onConnected"] = (listener) =>
    Effect.sync(() => {
      connectedListeners.add(listener);
      return () => {
        connectedListeners.delete(listener);
      };
    });

  yield* windows.observe({ kind: "game" }, (event) => {
    switch (event.type) {
      case "ready":
        return connect(event.rendererId);
      case "reloaded":
      case "crashed":
      case "closed":
        return disconnect(event.rendererId);
      default:
        return Effect.void;
    }
  });

  return GameRendererRpc.of({ call, onConnected });
});

const electronTransport: GameRendererRpcTransport = {
  open: (rendererId) => {
    const contents = electronRendererRegistry.fromId(rendererId);
    if (contents === undefined || contents.isDestroyed()) {
      return undefined;
    }
    const { port1, port2 } = new MessageChannelMain();
    contents.postMessage(GAME_RENDERER_RPC_PORT_CHANNEL, null, [port2]);
    return port1;
  },
};

export const layer = Layer.effect(
  GameRendererRpc,
  makeGameRendererRpc(electronTransport),
);
