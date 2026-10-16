import { contentTracing } from "electron";
import { vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ElectronApp } from "../../electron/ElectronApp";
import {
  ElectronChromiumPerformance,
  ElectronChromiumPerformanceError,
  layer as nativeChromiumLayer,
} from "../../electron/ElectronChromiumPerformance";
import { DesktopWindows } from "../../window/DesktopWindows";
import { layer as environmentLayer } from "../DesktopEnvironment";
import {
  DesktopChromiumPerformanceRecording,
  layer as chromiumLayer,
} from "./DesktopChromiumPerformanceRecording";

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "lucent-recordings-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);
const environment = (root: string) =>
  environmentLayer({
    appDataDir: root,
    assetsDir: join(root, "assets"),
    workspaceDir: join(root, "workspace"),
    isDev: false,
    platform: process.platform,
  });

describe("recording lifetimes", () => {
  it.effect(
    "interrupts pending Chromium samples before releasing debuggers and saving",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const events: string[] = [];
        let resources = 0;
        const layer = chromiumLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              environment(root),
              Layer.mock(ElectronApp, {
                getVersion: Effect.succeed("1.0.0"),
                getAppMetrics: Effect.sync(() => {
                  resources += 1;
                  return [];
                }),
              }),
              Layer.mock(DesktopWindows, {
                describe: (rendererId) =>
                  Effect.succeed({
                    rendererId,
                    kind: "game",
                    windowId: 1,
                    ownerId: undefined,
                    generation: 1,
                    ready: false,
                  }),
              }),
              Layer.mock(ElectronChromiumPerformance, {
                getCategories: Effect.succeed([]),
                getTraceBufferUsage: Effect.succeed({
                  percentage: 0,
                  value: 0,
                }),
                getMainHeapUsage: Effect.succeed({
                  externalBytes: 1,
                  heapTotalBytes: 2,
                  heapUsedBytes: 1,
                  rssBytes: 3,
                }),
                getRendererTargets: Effect.succeed([
                  { rendererId: 1, osProcessId: 2 },
                ]),
                getRendererHeapUsage: () =>
                  Effect.sync(() => {
                    events.push("sample:start");
                  }).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        events.push("sample:cancel");
                      }),
                    ),
                  ),
                startRecording: () => Effect.void,
                stopRecording: (path) => Effect.succeed(path),
                releaseRendererDebuggers: Effect.sync(() => {
                  events.push("debuggers:release");
                }),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(2500);
          expect(events).toEqual(["sample:start"]);
          const saved = yield* recording.stop;
          expect(events).toEqual([
            "sample:start",
            "sample:cancel",
            "debuggers:release",
          ]);
          expect(saved).toMatchObject({
            durationMs: 2500,
            resourceSampleCount: 3,
            traceSegmentCount: 1,
            warningCount: 0,
          });
          expect(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(saved!.manifestPath, "utf8"),
              ),
            ),
          ).toMatchObject({
            status: "complete",
            warnings: [],
            trace: { segments: [{ reason: "stop", durationMs: 2500 }] },
          });
          yield* TestClock.adjust(10_000);
          expect(resources).toBe(4);
          expect(events).toHaveLength(3);
          yield* recording.start;
          yield* Effect.yieldNow;
        }).pipe(Effect.provide(layer));
        expect(events).toEqual([
          "sample:start",
          "sample:cancel",
          "debuggers:release",
          "sample:start",
          "sample:cancel",
          "debuggers:release",
        ]);
        const before = resources;
        yield* TestClock.adjust(10_000);
        expect(resources).toBe(before);
      }),
  );
  for (const scenario of [
    {
      name: "buffer pressure",
      percentage: 0.8,
      queryFails: false,
      advanceMs: 1000,
      reason: "buffer",
      warningCount: 0,
    },
    {
      name: "duration limit",
      percentage: 0.2,
      queryFails: false,
      advanceMs: 120_000,
      reason: "duration",
      warningCount: 0,
    },
    {
      name: "buffer query failure",
      percentage: 0,
      queryFails: true,
      advanceMs: 120_000,
      reason: "duration",
      warningCount: 1,
    },
  ]) {
    it.effect(`rotates Chromium segments on ${scenario.name}`, () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const layer = chromiumLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              environment(root),
              Layer.mock(ElectronApp, {
                getVersion: Effect.succeed("1.0.0"),
                getAppMetrics: Effect.succeed([]),
              }),
              Layer.mock(DesktopWindows, {}),
              Layer.mock(ElectronChromiumPerformance, {
                getCategories: Effect.succeed([]),
                getTraceBufferUsage: scenario.queryFails
                  ? Effect.fail(
                      new ElectronChromiumPerformanceError({
                        operation: "get-trace-buffer-usage",
                        cause: new Error("Unavailable"),
                      }),
                    )
                  : Effect.succeed({
                      percentage: scenario.percentage,
                      value: 0,
                    }),
                getMainHeapUsage: Effect.succeed({
                  externalBytes: 1,
                  heapTotalBytes: 2,
                  heapUsedBytes: 1,
                  rssBytes: 3,
                }),
                getRendererTargets: Effect.succeed([]),
                startRecording: () => Effect.void,
                stopRecording: (path) => Effect.succeed(path),
                releaseRendererDebuggers: Effect.void,
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(scenario.advanceMs);
          const saved = yield* recording.stop;
          expect(saved).toMatchObject({
            traceSegmentCount: 2,
            warningCount: scenario.warningCount,
          });
          expect(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(saved!.manifestPath, "utf8"),
              ),
            ),
          ).toMatchObject({
            status: "complete",
            trace: {
              bufferUsageThreshold: 0.8,
              segments: [{ reason: scenario.reason }, { reason: "stop" }],
            },
          });
        }).pipe(Effect.provide(layer));
      }),
    );
  }
});

const nativeProbe = vi.hoisted(() => ({
  requests: 0,
  pending: [] as Promise<unknown>[],
}));
vi.mock("electron", () => ({
  contentTracing: {
    getCategories: async () => [],
    startRecording: async () => {},
    stopRecording: async (path: string) => path,
    getTraceBufferUsage: () => {
      nativeProbe.requests++;
      const request = new Promise(() => {});
      nativeProbe.pending.push(request);
      return request;
    },
  },
  webContents: { getAllWebContents: () => [], fromId: () => undefined },
}));
it.effect(
  "bounds stalled native buffer queries while duration rotation and stop still work",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const services = chromiumLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            environment(root),
            nativeChromiumLayer,
            Layer.mock(ElectronApp, {
              getVersion: Effect.succeed("1.0.0"),
              getAppMetrics: Effect.succeed([]),
            }),
            Layer.mock(DesktopWindows, {}),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        yield* recording.start;
        yield* TestClock.adjust(121000);
        const beforeStop = nativeProbe.requests;
        const saved = yield* recording.stop;
        const manifest = JSON.parse(
          yield* Effect.promise(() => readFile(saved!.manifestPath, "utf8")),
        );
        yield* TestClock.adjust(5000);
        expect(manifest).toMatchObject({
          trace: { segments: [{ reason: "duration" }, { reason: "stop" }] },
        });
        expect(nativeProbe.requests).toBe(beforeStop);
        expect(nativeProbe.pending).toHaveLength(1);
      }).pipe(Effect.provide(services));
    }),
);

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
