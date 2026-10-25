import { vi } from "vitest";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ElectronChromiumPerformance,
  layer as nativeChromiumLayer,
} from "./ElectronChromiumPerformance";

const native = vi.hoisted(() => ({
  start: vi.fn(async (_config: unknown) => {}),
  stop: vi.fn(async (path: string) => path),
  snapshot: vi.fn(async (_path: string) => {}),
}));

vi.mock("electron", () => {
  const renderers = [
    {
      id: 1,
      isDestroyed: () => false,
      getOSProcessId: () => 11,
      takeHeapSnapshot: native.snapshot,
    },
    {
      id: 2,
      isDestroyed: () => true,
      getOSProcessId: () => 12,
      takeHeapSnapshot: native.snapshot,
    },
  ];
  return {
    contentTracing: {
      getCategories: async () => [],
      startRecording: native.start,
      stopRecording: native.stop,
    },
    webContents: {
      getAllWebContents: () => renderers,
      fromId: (id: number) => renderers.find((renderer) => renderer.id === id),
    },
  };
});

it.effect("passes tracing configuration and the output path to Electron", () =>
  Effect.gen(function* () {
    const chromium = yield* ElectronChromiumPerformance;
    native.start.mockClear();
    native.stop.mockClear();
    yield* chromium.startRecording({
      recording_mode: "record-until-full",
      trace_buffer_size_in_kb: 262144,
    });
    expect(native.start.mock.calls).toEqual([
      [
        {
          recording_mode: "record-until-full",
          trace_buffer_size_in_kb: 262144,
        },
      ],
    ]);
    expect(yield* chromium.stopRecording("/recording/trace.json")).toBe(
      "/recording/trace.json",
    );
    expect(native.stop.mock.calls).toEqual([["/recording/trace.json"]]);
    native.start.mockRejectedValueOnce(new Error("Already tracing"));
    expect(yield* chromium.startRecording({}).pipe(Effect.flip)).toMatchObject({
      _tag: "ElectronChromiumPerformanceError",
      operation: "start-recording",
    });
  }).pipe(Effect.provide(nativeChromiumLayer)),
);

it.effect(
  "snapshots live renderers directly and reports vanished or failed targets",
  () =>
    Effect.gen(function* () {
      const chromium = yield* ElectronChromiumPerformance;
      native.snapshot.mockClear();
      expect(yield* chromium.getRendererTargets).toEqual([
        { rendererId: 1, osProcessId: 11 },
      ]);
      yield* chromium.takeRendererHeapSnapshot(
        1,
        "/recording/renderer-1.heapsnapshot",
      );
      expect(native.snapshot.mock.calls).toEqual([
        ["/recording/renderer-1.heapsnapshot"],
      ]);
      for (const id of [2, 3]) {
        expect(
          yield* chromium
            .takeRendererHeapSnapshot(id, "/recording/missing.heapsnapshot")
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ElectronChromiumPerformanceError",
          operation: `take-renderer-heap-snapshot:${id}`,
        });
      }
      native.snapshot.mockRejectedValueOnce(new Error("Snapshot failed"));
      expect(
        yield* chromium
          .takeRendererHeapSnapshot(1, "/recording/failed.heapsnapshot")
          .pipe(Effect.flip),
      ).toMatchObject({ operation: "take-renderer-heap-snapshot:1" });
    }).pipe(Effect.provide(nativeChromiumLayer)),
);

it.effect("checks Electron's main heap snapshot result", () =>
  Effect.gen(function* () {
    const descriptor = Object.getOwnPropertyDescriptor(
      process,
      "takeHeapSnapshot",
    );
    const snapshot = vi.fn((_path: string) => true);
    Object.defineProperty(process, "takeHeapSnapshot", {
      configurable: true,
      value: snapshot,
    });
    try {
      const chromium = yield* ElectronChromiumPerformance;
      yield* chromium.takeMainHeapSnapshot("/recording/main.heapsnapshot");
      expect(snapshot.mock.calls).toEqual([["/recording/main.heapsnapshot"]]);
      snapshot.mockReturnValueOnce(false);
      expect(
        yield* chromium
          .takeMainHeapSnapshot("/recording/failed.heapsnapshot")
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "ElectronChromiumPerformanceError",
        operation: "take-main-heap-snapshot",
      });
    } finally {
      if (descriptor === undefined)
        Reflect.deleteProperty(process, "takeHeapSnapshot");
      else Object.defineProperty(process, "takeHeapSnapshot", descriptor);
    }
  }).pipe(Effect.provide(nativeChromiumLayer)),
);
