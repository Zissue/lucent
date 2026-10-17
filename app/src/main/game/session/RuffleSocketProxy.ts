import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { pipeline } from "node:stream";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ScopedCache from "effect/ScopedCache";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";

import { logFailure } from "../../../shared/logFailure";
import { isArtixHost } from "./GameRequestHeaders";

interface RelayTarget {
  readonly host: string;
  readonly port: number;
}

const RELAY_HOST = "127.0.0.1";
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const MAX_CLOSE_REASON_BYTES = 120;

export class RuffleSocketProxyError extends Schema.TaggedError<RuffleSocketProxyError>()(
  "RuffleSocketProxyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to start the game's socket relay.";
  }
}

export class RuffleSocketProxy extends Context.Service<
  RuffleSocketProxy,
  {
    readonly getUrl: Effect.Effect<string, RuffleSocketProxyError>;
  }
>()("lucent/desktop/game/session/RuffleSocketProxy") {}

const requestUrl = (request: IncomingMessage): URL =>
  new URL(request.url ?? "/", "http://localhost");
const hasToken = (request: IncomingMessage, token: string): boolean => {
  try {
    return requestUrl(request).pathname === `/${token}`;
  } catch {
    return false;
  }
};
const parseRelayTarget = (request: IncomingMessage): RelayTarget | null => {
  const params = requestUrl(request).searchParams;
  const host = params.get("host");
  const port = Number(params.get("port"));
  if (
    host === null ||
    !isArtixHost(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    return null;
  return { host, port };
};

const relay = (
  ws: WebSocket,
  target: RelayTarget,
  connections: Set<Socket>,
  onFailure: (error: Error) => void,
  isClosing: () => boolean,
): void => {
  let failed = false;
  let closedNormally = false;
  ws.once("close", (code) => {
    closedNormally = code === 1000 || code === 1001 || code === 1005;
  });
  const reportFailure = (error: Error): void => {
    if (failed || closedNormally || isClosing()) return;
    failed = true;
    onFailure(error);
  };
  const tcp = createConnection({ ...target, noDelay: true });
  connections.add(tcp);
  tcp.once("close", () => connections.delete(tcp));
  tcp.on("error", (error) => {
    reportFailure(error);
    ws.close(
      INTERNAL_ERROR,
      Buffer.from(error.message)
        .subarray(0, MAX_CLOSE_REASON_BYTES)
        .toString("utf8"),
    );
  });
  const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
  pipeline(tcp, stream, tcp, (error) => {
    if (error) reportFailure(error);
    tcp.destroy();
    stream.destroy();
  });
};

const startRelay = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const token = randomBytes(32).toString("hex");
  const connections = new Set<Socket>();
  let closing = false;
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((_request, response) => {
        response.writeHead(426);
        response.end();
      }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const tcp of connections) tcp.destroy();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const websockets = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new WebSocketServer({
          server,
          perMessageDeflate: false,
          verifyClient: ({ req }: { req: IncomingMessage }) =>
            hasToken(req, token),
        }),
      catch: (cause) => new RuffleSocketProxyError({ cause }),
    }),
    (websockets) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            closing = true;
            for (const client of websockets.clients) client.terminate();
            websockets.close(() => resolve());
          }),
      ),
  );
  websockets.on("connection", (ws, request) => {
    const target = parseRelayTarget(request);
    if (target === null) {
      ws.close(POLICY_VIOLATION, "host not allowed");
      return;
    }
    relay(
      ws,
      target,
      connections,
      (error) => {
        runFork(
          logFailure("Ruffle socket connection failed", Cause.fail(error), {
            failure: "warning",
          }).pipe(
            Effect.annotateLogs({
              component: "ruffle-socket-relay",
              data: { host: target.host, port: target.port },
              repeatKey: `${target.host}:${target.port}`,
            }),
          ),
        );
      },
      () => closing,
    );
  });
  return yield* Effect.callback<string, RuffleSocketProxyError>((resume) => {
    let listening = false;
    websockets.on("error", (cause) => {
      if (listening) {
        runFork(
          Effect.logError("Ruffle socket relay failed", Cause.fail(cause)).pipe(
            Effect.annotateLogs({ component: "ruffle-socket-relay" }),
          ),
        );
      } else {
        resume(Effect.fail(new RuffleSocketProxyError({ cause })));
      }
    });
    server.listen(0, RELAY_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          Effect.fail(
            new RuffleSocketProxyError({
              cause: new Error("Missing relay address"),
            }),
          ),
        );
        return;
      }
      listening = true;
      resume(Effect.succeed(`ws://${RELAY_HOST}:${address.port}/${token}`));
    });
  });
});

export const layer = Layer.effect(
  RuffleSocketProxy,
  Effect.gen(function* () {
    const relay = yield* ScopedCache.makeWith<
      void,
      string,
      RuffleSocketProxyError
    >({
      lookup: Effect.fnUntraced(function* (_key: void) {
        const scope = yield* Scope.fork(yield* Effect.scope);
        return yield* startRelay.pipe(
          Scope.provide(scope),
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
      }),
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    });
    return RuffleSocketProxy.of({ getUrl: ScopedCache.get(relay, undefined) });
  }),
);
