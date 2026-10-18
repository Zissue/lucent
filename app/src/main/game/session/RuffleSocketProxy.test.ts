import { once } from "node:events";
import type { Duplex } from "node:stream";
import {
  desktopLogRecord,
  type DesktopLogRecord,
} from "../../../shared/logRecord";
import { Server as HttpServer } from "node:http";
import { createServer, type Socket, type TcpNetConnectOpts } from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import {
  afterAll,
  afterEach,
  beforeAll,
  layer as testLayer,
  expect,
} from "@effect/vitest";
import { vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";

const relayTest = vi.hoisted(() => ({
  servers: [] as WebSocketServer[],
  streams: [] as Duplex[],
  targetPort: 0,
  connect: vi.fn(),
  failStarts: 0,
  slowReader: false,
}));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    createWebSocketStream: (
      ...args: Parameters<typeof actual.createWebSocketStream>
    ) => {
      const stream = actual.createWebSocketStream(...args);
      relayTest.streams.push(stream);
      return stream;
    },
    WebSocketServer: class extends actual.WebSocketServer {
      constructor(
        options: ConstructorParameters<typeof actual.WebSocketServer>[0],
      ) {
        if (relayTest.failStarts > 0) {
          relayTest.failStarts -= 1;
          throw new Error("Relay startup failure");
        }
        super(options);
        relayTest.servers.push(this);
      }
    },
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: (options: TcpNetConnectOpts) => {
      relayTest.connect(options);
      return actual.createConnection({
        ...options,
        host: "127.0.0.1",
        port: relayTest.targetPort,
      });
    },
  };
});

import { RuffleSocketProxy, layer as proxyLayer } from "./RuffleSocketProxy";
const getUrl = RuffleSocketProxy.use((relay) => relay.getUrl);
const withProxy = Effect.fn(function* (test: (url: string) => Promise<void>) {
  const url = yield* getUrl;
  yield* Effect.promise(() => test(url));
});

const echoConnections = new Set<Socket>();
const echo = createServer((socket) => {
  echoConnections.add(socket);
  socket.once("close", () => echoConnections.delete(socket));
  socket.on("error", () => {});
  socket.pipe(socket);
  if (relayTest.slowReader) socket.pause();
});
const clients = new Set<WebSocket>();

const connect = (url: string): WebSocket => {
  const client = new WebSocket(url, { origin: "https://untrusted.example" });
  client.on("error", () => {});
  clients.add(client);
  return client;
};

beforeAll(async () => {
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const address = echo.address();
  if (address === null || typeof address === "string")
    throw new Error("No TCP address");
  relayTest.targetPort = address.port;
});

afterEach(() => {
  for (const client of clients) client.terminate();
  clients.clear();
  relayTest.streams.length = 0;
  relayTest.connect.mockClear();
  relayTest.slowReader = false;
  for (const socket of echoConnections) socket.resume();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    echo.close((error) => (error ? reject(error) : resolve())),
  );
});

testLayer(proxyLayer)("Ruffle socket relay", (it) => {
  for (const pathname of ["/", "/wrong-token"]) {
    it.effect(`rejects ${pathname} before opening a TCP connection`, () =>
      withProxy(async (proxyUrl) => {
        const url = new URL(proxyUrl);
        url.pathname = pathname;
        url.search = "?host=game.aq.com&port=5588";
        const client = connect(url.toString());
        const [, response] = await once(client, "unexpected-response");
        expect(response.statusCode).toBe(401);
        response.resume();
        expect(relayTest.connect).not.toHaveBeenCalled();
      }),
    );
  }

  it.effect("relays binary data when the client has the session token", () =>
    withProxy(async (proxyUrl) => {
      const client = connect(`${proxyUrl}?host=game.aq.com&port=5588`);
      await once(client, "open");
      const response = once(client, "message");
      client.send(Buffer.from([0, 1, 2, 255]));
      const [data, binary] = await response;
      expect(data).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(binary).toBe(true);
      expect(relayTest.connect).toHaveBeenCalledWith({
        host: "game.aq.com",
        port: 5588,
        noDelay: true,
      });
    }),
  );

  for (const port of ["0", "-1", "65536", "1.5", "Infinity"]) {
    it.effect(`rejects invalid destination port ${port}`, () =>
      withProxy(async (proxyUrl) => {
        const client = connect(`${proxyUrl}?host=game.aq.com&port=${port}`);
        const [code] = await once(client, "close");
        expect(code).toBe(1008);
        expect(relayTest.connect).not.toHaveBeenCalled();
      }),
    );
  }

  it.effect.each([
    "port=5588",
    "host=localhost&port=5588",
    "host=aq.com.example.com&port=5588",
    "host=notaq.com&port=5588",
    "host=game.aq.com",
    "host=game.aq.com&port=",
    "host=game.aq.com&port=NaN",
  ])("rejects invalid relay destination fields %s", (query) =>
    withProxy(async (proxyUrl) => {
      const client = connect(`${proxyUrl}?${query}`);
      const [code, reason] = await once(client, "close");
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("host not allowed");
      expect(relayTest.connect).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["0x15d4", "5.588e3", "05588", " 5588 "])(
    "preserves numeric port coercion for %s",
    (port) =>
      withProxy(async (proxyUrl) => {
        const client = connect(
          `${proxyUrl}?host=GAME.AQ.COM&port=${encodeURIComponent(port)}`,
        );
        await once(client, "open");
        const response = once(client, "message");
        client.send(Buffer.from("coerced port"));
        expect((await response)[0].toString()).toBe("coerced port");
        expect(relayTest.connect).toHaveBeenCalledWith({
          host: "GAME.AQ.COM",
          port: 5588,
          noDelay: true,
        });
      }),
  );

  it.effect("rejects a malformed handshake URL before upgrading", () =>
    withProxy(async (proxyUrl) => {
      const url = new URL(proxyUrl);
      const client = new WebSocket(proxyUrl, {
        finishRequest(request) {
          request.path = `http://[invalid${url.pathname}?host=game.aq.com&port=5588`;
          request.end();
        },
      });
      client.on("error", () => {});
      clients.add(client);
      const [, response] = await once(client, "unexpected-response");
      expect(response.statusCode).toBe(401);
      response.resume();
      expect(relayTest.connect).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "retries failed startup and shuts down every open connection with its scope",
    () =>
      Effect.gen(function* () {
        const original = yield* getUrl;
        const logs: string[] = [];
        const closed = yield* Effect.gen(function* () {
          relayTest.failStarts = 1;
          const failed = yield* getUrl.pipe(Effect.flip);
          expect(failed.cause).toEqual(new Error("Relay startup failure"));
          const urls = yield* Effect.all([getUrl, getUrl], {
            concurrency: "unbounded",
          });
          expect(urls[0]).toBe(urls[1]);
          expect(urls[0]).not.toBe(original);
          const client = connect(`${urls[0]}?host=game.aq.com&port=5588`);
          yield* Effect.promise(() => once(client, "open"));
          return { client, closed: once(client, "close") };
        }).pipe(
          Effect.provide(Layer.fresh(proxyLayer)),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                logs.push(Cause.pretty(options.cause));
              }),
            ]),
          ),
        );
        expect(logs).toEqual([]);
        yield* Effect.promise(() => closed.closed);
        expect(closed.client.readyState).toBe(WebSocket.CLOSED);
        expect(relayTest.servers.at(-1)?.address()).toBeNull();
      }),
  );

  it.effect(
    "reports bind failures and retries without an unhandled error",
    () =>
      Effect.gen(function* () {
        const logs: string[] = [];
        const listen = HttpServer.prototype.listen;
        const failBind = vi
          .spyOn(HttpServer.prototype, "listen")
          .mockImplementationOnce(function (this: HttpServer) {
            return listen.call(this, {
              port: relayTest.targetPort,
              host: "127.0.0.1",
            });
          });
        try {
          yield* Effect.gen(function* () {
            const failure = yield* getUrl.pipe(Effect.flip);
            expect(failure.cause).toMatchObject({ code: "EADDRINUSE" });
            expect(logs).toEqual([]);
            const url = yield* getUrl;
            expect(new URL(url).protocol).toBe("ws:");
          }).pipe(
            Effect.provide(Layer.fresh(proxyLayer)),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
            Effect.provide(
              Logger.layer([
                Logger.make((options) => {
                  logs.push(Cause.pretty(options.cause));
                }),
              ]),
            ),
          );
        } finally {
          failBind.mockRestore();
        }
      }),
  );

  it.effect(
    "pauses incoming WebSocket data for a slow TCP peer and resumes without loss",
    () =>
      withProxy(async (proxyUrl) => {
        relayTest.slowReader = true;
        const client = connect(`${proxyUrl}?host=game.aq.com&port=5588`);
        await once(client, "open");
        const chunk = Buffer.alloc(64 * 1024, 85);
        const totalBytes = chunk.byteLength * 128;
        let received = 0;
        const completed = new Promise<void>((resolve, reject) => {
          client.on("message", (data: Buffer) => {
            if (!data.equals(Buffer.alloc(data.length, 85))) {
              reject(new Error("Relay corrupted bytes"));
              return;
            }
            received += data.length;
            if (received === totalBytes) resolve();
          });
          client.once("error", reject);
        });
        for (let index = 0; index < 128; index += 1) client.send(chunk);
        await vi.waitFor(() =>
          expect(
            [...relayTest.servers[0]!.clients].some(
              (socket) => socket.isPaused,
            ),
          ).toBe(true),
        );
        for (const socket of echoConnections) socket.resume();
        await completed;
        expect(received).toBe(totalBytes);
      }),
  );
});

testLayer(proxyLayer)("Ruffle connection failure logging", (it) => {
  it.effect.each(["tcp", "pipeline"] as const)(
    "logs %s failure once per connection",
    (source) => {
      const records: DesktopLogRecord[] = [];
      return Effect.gen(function* () {
        const originalPort = relayTest.targetPort;
        if (source === "tcp") {
          const unused = createServer();
          unused.listen(0, "127.0.0.1");
          yield* Effect.promise(() => once(unused, "listening"));
          const address = unused.address();
          if (address === null || typeof address === "string")
            throw new Error("Missing test address");
          relayTest.targetPort = address.port;
          yield* Effect.promise(
            () => new Promise<void>((resolve) => unused.close(() => resolve())),
          );
        }
        try {
          yield* withProxy(async (url) => {
            const client = connect(`${url}?host=game.aq.com&port=5588`);
            const closed = once(client, "close");
            await once(client, "open");
            if (source === "pipeline") {
              await vi.waitFor(() => expect(relayTest.streams.length).toBe(1));
              relayTest.streams[0]!.destroy(new Error("stream failed"));
            }
            await closed;
            await new Promise<void>((resolve) => setImmediate(resolve));
          });
          expect(records).toMatchObject([
            {
              level: "warn",
              message: "Ruffle socket connection failed",
              component: "ruffle-socket-relay",
              data: { host: "game.aq.com", port: 5588 },
            },
          ]);
          expect(records[0]?.data).toEqual({ host: "game.aq.com", port: 5588 });
          expect(records[0]?.error?.[0]?.message).toEqual(
            source === "pipeline"
              ? "stream failed"
              : expect.stringContaining("ECONNREFUSED"),
          );
        } finally {
          relayTest.targetPort = originalPort;
        }
      }).pipe(
        Effect.provide(Layer.fresh(proxyLayer)),
        Effect.provide(
          Logger.layer(
            [Logger.make((options) => records.push(desktopLogRecord(options)))],
            { mergeWithExisting: false },
          ),
        ),
      );
    },
  );

  it.effect("keeps normal close and scope teardown silent", () => {
    const records: DesktopLogRecord[] = [];
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* withProxy(async (url) => {
          const client = connect(`${url}?host=game.aq.com&port=5588`);
          await once(client, "open");
          const response = once(client, "message");
          client.send(Buffer.from([1, 2, 3]));
          expect((await response)[0]).toEqual(Buffer.from([1, 2, 3]));
          const closed = once(client, "close");
          client.close();
          expect((await closed)[0]).toBe(1005);
          const pending = connect(`${url}?host=game.aq.com&port=5588`);
          await once(pending, "open");
          pending.send(Buffer.alloc(1024));
        });
      }).pipe(
        Effect.provide(Layer.fresh(proxyLayer)),
        Effect.provide(
          Logger.layer(
            [Logger.make((options) => records.push(desktopLogRecord(options)))],
            { mergeWithExisting: false },
          ),
        ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
      expect(records).toEqual([]);
    });
  });
});
