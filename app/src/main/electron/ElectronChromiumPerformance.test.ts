import { contentTracing } from "electron";
import { vi } from "vitest";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ElectronChromiumPerformance,
  layer as nativeChromiumLayer,
} from "./ElectronChromiumPerformance";

vi.mock("electron", () => ({
  contentTracing: {
    getTraceBufferUsage: vi.fn(),
  },
}));

it.effect("retries native buffer queries after success and failure", () =>
  Effect.gen(function* () {
    const query = vi
      .spyOn(contentTracing, "getTraceBufferUsage")
      .mockResolvedValueOnce({ percentage: 0.2, value: 20 })
      .mockRejectedValueOnce(new Error("Query failed"))
      .mockResolvedValueOnce({ percentage: 0.8, value: 80 });
    try {
      yield* Effect.gen(function* () {
        const chromium = yield* ElectronChromiumPerformance;
        expect(yield* chromium.getTraceBufferUsage).toEqual({
          percentage: 0.2,
          value: 20,
        });
        expect(
          yield* chromium.getTraceBufferUsage.pipe(Effect.flip),
        ).toMatchObject({ operation: "get-trace-buffer-usage" });
        expect(yield* chromium.getTraceBufferUsage).toEqual({
          percentage: 0.8,
          value: 80,
        });
      }).pipe(Effect.provide(nativeChromiumLayer));
    } finally {
      query.mockRestore();
    }
  }),
);
