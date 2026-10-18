import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import { afterEach, expect, layer as testLayer } from "@effect/vitest";
import { gzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  DesktopHttpClient,
  layer,
  makeDesktopHttpClient,
} from "./DesktopHttpClient";
import * as TestClock from "effect/testing/TestClock";
const cleanups: (() => Promise<void>)[] = [];
const server = async (
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) => {
  const instance = createServer(handle);
  const sockets = new Set<Socket>();
  instance.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        instance.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = instance.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP server");
  return new URL(`http://127.0.0.1:${address.port}/`);
};
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
testLayer(layer)("Desktop HTTP request lifecycle", (it) => {
  it.effect(
    "reports native response inactivity as timeout and closes the connection",
    () =>
      Effect.gen(function* () {
        const closed = Promise.withResolvers<void>();
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            response.on("close", () => closed.resolve());
            response.write("partial");
          }),
        );
        const transport = yield* HttpClient.HttpClient;
        const http = yield* makeDesktopHttpClient.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            transport.pipe(
              HttpClient.mapRequest(HttpClientRequest.setUrl(url)),
            ),
          ),
          Effect.provide(NodeFileSystem.layer),
        );
        const error = yield* http
          .get({ url: new URL("https://example.com/"), timeoutMs: 100 })
          .pipe(Effect.flip);
        expect(error.kind).toBe("timeout");
        yield* Effect.promise(() => closed.promise);
      }).pipe(TestClock.withLive),
  );

  it.effect(
    "resets the native inactivity timeout while response bytes arrive",
    () =>
      Effect.gen(function* () {
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            let chunks = 0;
            const timer = setInterval(() => {
              response.write("tick");
              chunks += 1;
              if (chunks === 10) {
                clearInterval(timer);
                response.end();
              }
            }, 25);
            response.on("close", () => clearInterval(timer));
          }),
        );
        const transport = yield* HttpClient.HttpClient;
        const http = yield* makeDesktopHttpClient.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            transport.pipe(
              HttpClient.mapRequest(HttpClientRequest.setUrl(url)),
            ),
          ),
          Effect.provide(NodeFileSystem.layer),
        );
        const response = yield* http.get({
          url: new URL("https://example.com/"),
          timeoutMs: 150,
        });
        expect(response.body.toString()).toBe("tick".repeat(10));
      }).pipe(TestClock.withLive),
  );

  it.effect(
    "preserves extension methods, status text, repeated cookies, and encoded response bytes",
    () =>
      Effect.gen(function* () {
        const compressed = gzipSync("payload");
        let method: string | undefined;
        const url = yield* Effect.promise(() =>
          server((request, response) => {
            method = request.method;
            response.writeHead(207, "Custom status", {
              "set-cookie": ["a=1", "b=2"],
              "content-encoding": "gzip",
            });
            response.end(compressed);
          }),
        );
        const response = yield* (yield* DesktopHttpClient).request({
          url,
          method: "PROPFIND",
        });
        expect(method).toBe("PROPFIND");
        expect(response.statusCode).toBe(207);
        expect(response.statusMessage).toBe("Custom status");
        expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
        expect(response.body).toEqual(compressed);
      }),
  );

  it.effect(
    "fails at the redirect limit and closes unfinished redirect bodies",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const closed = Promise.withResolvers<void>();
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            requests += 1;
            if (requests === 1) response.on("close", () => closed.resolve());
            response.writeHead(302, { location: "/again" });
            response.write("unfinished redirect");
          }),
        );
        const result = yield* (yield* DesktopHttpClient)
          .request({ url, maxRedirects: 2 })
          .pipe(Effect.flip);
        expect(result.kind).toBe("redirect-failed");
        expect(requests).toBe(3);
        yield* Effect.promise(() => closed.promise);
      }),
  );
  it.effect.each([303, 307])(
    "handles methods, bytes, and credentials across a %i redirect",
    (status) =>
      Effect.gen(function* () {
        const destination = yield* Effect.promise(() =>
          server((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () =>
              response.end(
                JSON.stringify({
                  method: request.method,
                  body: Buffer.concat(chunks).toString(),
                  authorization: request.headers.authorization,
                  contentType: request.headers["content-type"],
                }),
              ),
            );
          }),
        );
        const source = yield* Effect.promise(() =>
          server((_request, response) => {
            response.writeHead(status, { location: destination.href });
            response.end();
          }),
        );
        const result = yield* (yield* DesktopHttpClient).request({
          url: source,
          method: "POST",
          body: new Uint8Array(Buffer.from("!payload?")).subarray(1, -1),
          headers: { authorization: "secret", "content-type": "text/plain" },
        });
        expect(JSON.parse(result.body.toString())).toEqual({
          method: status === 303 ? "GET" : "POST",
          body: status === 303 ? "" : "payload",
          ...(status === 303 ? {} : { contentType: "text/plain" }),
        });
        expect(result.url).toBe(destination.href);
      }),
  );
  it.effect(
    "returns manual redirects and HTTP failures without following or failing them",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            calls += 1;
            response.writeHead(302, { location: "/elsewhere" });
            response.end("redirect");
          }),
        );
        const result = yield* (yield* DesktopHttpClient).request({
          url,
          redirect: "manual",
        });
        expect(result.statusCode).toBe(302);
        expect(result.body.toString()).toBe("redirect");
        expect(calls).toBe(1);
        const error = yield* (yield* DesktopHttpClient)
          .request({ url, redirect: "error" })
          .pipe(Effect.flip);
        expect(error.kind).toBe("redirect-failed");
      }),
  );
  it.effect(
    "rejects tunnels and protocol upgrades instead of leaving requests pending",
    () =>
      Effect.gen(function* () {
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            response.writeHead(101, {
              connection: "Upgrade",
              upgrade: "websocket",
            });
            response.end();
          }),
        );
        const http = yield* DesktopHttpClient;
        expect(
          (yield* http.request({ url, method: "CONNECT" }).pipe(Effect.flip))
            .kind,
        ).toBe("request-failed");
        expect((yield* http.request({ url }).pipe(Effect.flip)).kind).toBe(
          "request-failed",
        );
      }),
  );
  it.effect(
    "interrupts the connection while the response body is still downloading",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const url = yield* Effect.promise(() =>
          server((_request, response) => {
            response.on("close", () => closed.resolve());
            response.write("partial");
            started.resolve();
          }),
        );
        const fiber = yield* Effect.forkChild(
          (yield* DesktopHttpClient).request({ url }),
        );
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(() => closed.promise);
        expect(fiber.pollUnsafe()).toBeDefined();
      }),
  );
  it.effect(
    "uses one deadline across redirects and a partial response body",
    () =>
      Effect.gen(function* () {
        const first = Promise.withResolvers<ServerResponse>();
        const second = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const url = yield* Effect.promise(() =>
          server((request, response) => {
            if (request.url === "/") first.resolve(response);
            else {
              response.on("close", () => closed.resolve());
              response.write("partial");
              second.resolve();
            }
          }),
        );
        const result = yield* Effect.forkChild(
          (yield* DesktopHttpClient)
            .request({ url, timeoutMs: 100 })
            .pipe(Effect.flip),
        );
        const response = yield* Effect.promise(() => first.promise);
        yield* TestClock.adjust(60);
        response.writeHead(302, { location: "/body" });
        response.end();
        yield* Effect.promise(() => second.promise);
        yield* TestClock.adjust(40);
        expect((yield* Fiber.join(result)).kind).toBe("timeout");
        yield* Effect.promise(() => closed.promise);
      }),
  );
  it.effect.each([4])(
    "enforces a %s byte streamed limit but exempts HEAD content-length",
    (maxBytes) =>
      Effect.gen(function* () {
        const url = yield* Effect.promise(() =>
          server((request, response) => {
            if (request.method === "HEAD") {
              response.writeHead(200, { "content-length": "9999999" });
              response.end();
            } else {
              response.write("1234");
              response.end("5678");
            }
          }),
        );
        const http = yield* DesktopHttpClient;
        expect(
          (yield* http.request({ url, maxBytes }).pipe(Effect.flip)).kind,
        ).toBe("response-too-large");
        expect(
          (yield* http.request({ url, method: "HEAD", maxBytes })).body
            .byteLength,
        ).toBe(0);
      }),
  );
});
