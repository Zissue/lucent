import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import type { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AccountServers, layer as serversLayer } from "./AccountServers";
import { layer as environmentLayer } from "../../app/DesktopEnvironment";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  pingAccountServers,
  type AccountServerData,
} from "./AccountServerPing";

const sockets = vi.hoisted(
  () => [] as Array<EventEmitter & { destroyed: boolean }>,
);
vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Socket: class extends EventEmitter {
      destroyed = false;
      constructor() {
        super();
        sockets.push(this);
      }
      connect({ port }: { port: number }) {
        if (port < 0) throw new Error("Invalid port");
        return this;
      }
      unref() {
        return this;
      }
      destroy() {
        this.destroyed = true;
        return this;
      }
    },
  };
});

const server = (
  name: string,
  overrides: Partial<AccountServerData> = {},
): AccountServerData => ({
  sName: name,
  sIP: "localhost",
  iPort: 5588,
  bOnline: 1,
  bUpg: 0,
  iCount: 10,
  iMax: 1000,
  sLang: "en",
  ...overrides,
});

afterEach(() => {
  sockets.length = 0;
});

describe("account server pings", () => {
  it.effect(
    "reports offline, success, invalid targets, and deadlines in input order",
    () =>
      Effect.gen(function* () {
        const pending = yield* pingAccountServers([
          server("Offline", { bOnline: 0 }),
          server("Connected"),
          server("Invalid", { iPort: -1 }),
          server("Timed out"),
        ]).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(sockets).toHaveLength(3);
        yield* TestClock.adjust(25);
        sockets[0]!.emit("connect");
        yield* TestClock.adjust(1975);
        expect(yield* Fiber.join(pending)).toEqual([
          { serverName: "Offline", status: "offline" },
          { serverName: "Connected", status: "ok", latencyMs: 25 },
          { serverName: "Invalid", status: "unreachable" },
          { serverName: "Timed out", status: "timeout" },
        ]);
        expect(
          sockets.every(
            (socket) => socket.destroyed && socket.eventNames().length === 0,
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "limits concurrency to six and cancels every outstanding connection",
    () =>
      Effect.gen(function* () {
        const pending = yield* pingAccountServers(
          Array.from({ length: 20 }, (_, i) => server(String(i))),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(sockets).toHaveLength(6);
        sockets[0]!.emit("connect");
        yield* Effect.yieldNow;
        expect(sockets).toHaveLength(7);
        yield* Fiber.interrupt(pending);
        yield* TestClock.adjust(10_000);
        expect(sockets).toHaveLength(7);
        expect(
          sockets.every(
            (socket) => socket.destroyed && socket.eventNames().length === 0,
          ),
        ).toBe(true);
      }),
  );
  it.effect(
    "shares ping loads, expires them after completion, and invalidates them on refresh",
    () => {
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify([
                server("Artix", { bOnline: requests > 1 ? 0 : 1 }),
                server("Yorumi"),
              ]),
            ),
          );
        }),
      );
      return Effect.gen(function* () {
        const accounts = yield* AccountServers;
        const pending = yield* Effect.all(
          [accounts.getPings, accounts.getPings],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(sockets).toHaveLength(2)),
        );
        expect(requests).toBe(1);
        yield* TestClock.adjust(10);
        for (const socket of sockets) socket.emit("connect");
        const [first, concurrent] = yield* Fiber.join(pending);
        expect(first).toEqual(concurrent);
        expect(first.measuredAt).toBe(10);
        expect(first.expiresAt).toBe(30_010);
        yield* TestClock.adjust(29_999);
        expect(yield* accounts.getPings).toEqual(first);
        expect(sockets).toHaveLength(2);
        yield* TestClock.adjust(1);
        const next = yield* accounts.getPings.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(sockets).toHaveLength(4);
        for (const socket of sockets.slice(2)) socket.emit("connect");
        yield* Fiber.join(next);
        yield* accounts.refresh;
        const refreshed = yield* accounts.getPings.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(requests).toBe(2);
        expect(sockets).toHaveLength(5);
        sockets[4]!.emit("connect");
        expect((yield* Fiber.join(refreshed)).pings[0]).toEqual({
          serverName: "Artix",
          status: "offline",
        });
        yield* accounts.refresh;
        expect(requests).toBe(2);
      }).pipe(
        Effect.provide(
          serversLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HttpClient.HttpClient, client),
                environmentLayer({
                  appDataDir: "/tmp/lucent-pings",
                  assetsDir: "/tmp/lucent-pings/assets",
                  isDev: false,
                  platform: process.platform,
                  workspaceDir: "/tmp/lucent-pings/workspace",
                }),
              ),
            ),
          ),
        ),
      );
    },
  );
});

it.effect("keeps six sockets across overlapping refreshes", () => {
  let requests = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests += 1;
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            Array.from({ length: 12 }, (_, i) => server(`Server${i}`)),
          ),
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const accounts = yield* AccountServers;
    const first = yield* accounts.getPings.pipe(Effect.forkScoped);
    yield* Effect.promise(() =>
      vi.waitFor(() => expect(sockets).toHaveLength(6)),
    );
    const before = sockets.filter((s) => !s.destroyed).length;
    yield* accounts.refresh;
    const refreshed = yield* accounts.getPings.pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Effect.promise(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    const after = sockets.filter((s) => !s.destroyed).length;
    expect(requests).toBe(2);
    expect(before).toBe(6);
    expect(after).toBe(6);
    for (const count of [6, 12, 18, 24]) {
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(sockets).toHaveLength(count)),
      );
      const active = sockets.filter((socket) => !socket.destroyed);
      expect(active).toHaveLength(6);
      for (const socket of active) socket.emit("connect");
    }
    expect((yield* Fiber.join(first)).pings).toHaveLength(12);
    expect((yield* Fiber.join(refreshed)).pings).toHaveLength(12);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  }).pipe(
    Effect.provide(
      serversLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, client),
            environmentLayer({
              appDataDir: "/tmp/lucent-pings",
              assetsDir: "/tmp/lucent-pings",
              workspaceDir: "/tmp/lucent-pings",
              isDev: false,
              platform: process.platform,
            }),
          ),
        ),
      ),
    ),
  );
});
