import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DesktopGamePacketsBridge } from "../../../shared/desktopBridge";
import { Api, type ApiService } from "./flash";
import { installPacketsBridge } from "./packetsBridge";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("packets bridge", () => {
  it.effect("delays only between queued packet sends", () => {
    const sends: Array<{ readonly at: number; readonly packet: string }> = [];
    const api = {
      events: {
        on: () => Effect.succeed(() => undefined),
      },
      packet: {
        sendToClient: () => Effect.succeed(true),
        sendToServer: (packet: string) =>
          Effect.sync(() => {
            sends.push({ at: Date.now(), packet });
            return true;
          }),
      },
    } as unknown as ApiService;

    return Effect.gen(function* () {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);

      const context = yield* Effect.context<Api>();
      const runtime = {
        runPromise: Effect.runPromiseWith(context),
      } as unknown as Parameters<typeof installPacketsBridge>[0];

      const bridge: DesktopGamePacketsBridge = {
        publishCaptured: async () => undefined,
        publishStatus: async () => undefined,
      };
      const controller = installPacketsBridge(runtime, bridge);
      controller.startQueue({
        delayMs: 1_000,
        packets: ["first", "second"],
        target: "server-string",
      });
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));

      expect(sends).toEqual([{ at: 1_000, packet: "first" }]);

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(999));
      expect(sends).toHaveLength(1);

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
      expect(sends).toEqual([
        { at: 1_000, packet: "first" },
        { at: 2_000, packet: "second" },
      ]);

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
      expect(sends).toEqual([
        { at: 1_000, packet: "first" },
        { at: 2_000, packet: "second" },
        { at: 3_000, packet: "first" },
      ]);

      controller.dispose();
    }).pipe(Effect.provideService(Api, api));
  });
});
