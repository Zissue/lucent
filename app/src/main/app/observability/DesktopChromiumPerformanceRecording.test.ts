import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ProcessMetric } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as TestClock from "effect/testing/TestClock";

import { ElectronApp } from "../../electron/ElectronApp";
import {
  ElectronChromiumPerformance,
  ElectronChromiumPerformanceError,
  type ElectronChromiumPerformanceShape,
} from "../../electron/ElectronChromiumPerformance";
import { layer as environmentLayer } from "../DesktopEnvironment";
import { DesktopWindows } from "../../window/DesktopWindows";
import {
  DesktopChromiumPerformanceRecording,
  type DesktopChromiumPerformanceRecordingState,
  layer as chromiumRecordingLayer,
} from "./DesktopChromiumPerformanceRecording";

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "lucent-recordings-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

const saveSnapshot = (path: string) =>
  Effect.promise(() => writeFile(path, "heap snapshot"));
const fileSystemLayer = Layer.effect(
  FileSystem,
  Effect.map(
    FileSystem,
    (fileSystem): FileSystem => ({
      ...fileSystem,
      writeFileString: (path, data, options) =>
        Effect.sync(() => writeFileSync(path, data, options)),
    }),
  ),
).pipe(Layer.provide(NodeFileSystem.layer));

const services = (
  root: string,
  chromium: Partial<ElectronChromiumPerformanceShape> = {},
  metrics: Effect.Effect<readonly ProcessMetric[]> = Effect.succeed([]),
  fileSystem: Layer.Layer<FileSystem> = fileSystemLayer,
) =>
  chromiumRecordingLayer.pipe(
    Layer.provide(fileSystem),
    Layer.provide(
      Layer.mergeAll(
        environmentLayer({
          appDataDir: root,
          assetsDir: join(root, "assets"),
          workspaceDir: join(root, "workspace"),
          isDev: false,
          platform: process.platform,
        }),
        Layer.mock(ElectronApp, {
          getVersion: Effect.succeed("1.0.0"),
          getAppMetrics: metrics,
        }),
        Layer.mock(DesktopWindows, {
          describe: (rendererId) => {
            const kind = (
              ["game", "settings", "game-host", "game-group-controls"] as const
            )[rendererId - 1];
            return Effect.succeed(
              kind === undefined
                ? undefined
                : {
                    rendererId,
                    kind,
                    windowId: rendererId,
                    ownerId: undefined,
                    generation: 1,
                    ready: true,
                  },
            );
          },
        }),
        Layer.succeed(ElectronChromiumPerformance, {
          getCategories: Effect.succeed(["v8", "electron"]),
          getRendererTargets: Effect.succeed([]),
          startRecording: () => Effect.void,
          stopRecording: (path) =>
            Effect.promise(async () => {
              await writeFile(path, '{"traceEvents":[]}');
              return path;
            }),
          takeMainHeapSnapshot: saveSnapshot,
          takeRendererHeapSnapshot: (_id, path) => saveSnapshot(path),
          ...chromium,
        }),
      ),
    ),
  );

const nativeFailure = (operation: string) =>
  new ElectronChromiumPerformanceError({
    operation,
    cause: new Error("Unavailable"),
  });

const readJson = (path: string) =>
  Effect.promise(async () => JSON.parse(await readFile(path, "utf8")));

const readSamples = (sessionPath: string) =>
  Effect.promise(async () =>
    (await readFile(join(sessionPath, "metrics.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );

const sampleMetric: ProcessMetric = {
  pid: 10,
  type: "Browser",
  creationTime: 123,
  cpu: { percentCPUUsage: 5, idleWakeupsPerSecond: 2, cumulativeCPUUsage: 1 },
  memory: { workingSetSize: 100, peakWorkingSetSize: 200, privateBytes: 75 },
};

describe("Chromium performance recordings", () => {
  it.effect("pins recording timestamps and logs lifecycle events", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1234567890000);
      const root = yield* fixture;
      const records: {
        annotations: Readonly<Record<string, unknown>>;
        level: string;
        message: unknown;
      }[] = [];
      const logger = Logger.make((options) => {
        records.push({
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
          level: options.logLevel,
          message: options.message,
        });
      });
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        const states: DesktopChromiumPerformanceRecordingState[] = [];
        yield* recording.onChanged((state) => {
          states.push(state);
        });
        expect(yield* recording.getState).toEqual({ status: "idle" });
        expect(yield* recording.stop).toBeUndefined();
        expect(
          yield* recording.captureHeapSnapshot.pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DesktopChromiumPerformanceRecordingError",
          message: "No Chromium performance recording is active.",
        });
        yield* recording.start;
        expect(yield* recording.start.pipe(Effect.flip)).toMatchObject({
          message: "A Chromium performance recording is already recording.",
        });
        yield* TestClock.adjust(100);
        const checkpoint = yield* recording.captureHeapSnapshot;
        expect(checkpoint).toMatchObject({
          failedSnapshotCount: 0,
          snapshotCount: 1,
        });
        const saved = yield* recording.stop;
        const manifest = yield* readJson(saved!.manifestPath);
        expect(manifest).toMatchObject({
          schemaVersion: 4,
          durationMs: 125,
          startedAt: "2009-02-13T23:31:30.000Z",
          endedAt: "2009-02-13T23:31:30.125Z",
          heapCheckpoints: [
            {
              directoryName: "checkpoint-000-2009-02-13T23-31-30-100Z",
              startedAt: "2009-02-13T23:31:30.100Z",
              endedAt: "2009-02-13T23:31:30.125Z",
            },
          ],
          trace: {
            fileName: "trace.json",
            status: "saved",
            recordingMode: "record-continuously",
            bufferSizeKiB: 262144,
          },
        });
        expect(states).toEqual([
          { status: "recording", startedAt: "2009-02-13T23:31:30.000Z" },
          { status: "snapshotting", startedAt: "2009-02-13T23:31:30.000Z" },
          { status: "recording", startedAt: "2009-02-13T23:31:30.000Z" },
          { status: "saving", startedAt: "2009-02-13T23:31:30.000Z" },
          { status: "idle" },
        ]);
        expect(yield* recording.getState).toEqual({ status: "idle" });
      }).pipe(
        Effect.provide(
          services(root, {
            takeMainHeapSnapshot: (path) =>
              TestClock.adjust(25).pipe(Effect.andThen(saveSnapshot(path))),
          }),
        ),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      );
      expect(records).toEqual([
        {
          annotations: {
            component: "chromium-performance-recording",
            data: {
              sessionName: `lucent-chromium-recording-2009-02-13T23-31-30-000Z-${process.pid}`,
            },
          },
          level: "Info",
          message: ["Chromium performance recording started"],
        },
        {
          annotations: {
            component: "chromium-performance-recording",
            data: {
              sessionName: `lucent-chromium-recording-2009-02-13T23-31-30-000Z-${process.pid}`,
            },
          },
          level: "Info",
          message: ["Chromium performance recording saved"],
        },
      ]);
    }),
  );

  it.effect(
    "appends 1-second process samples before stop and saves one trace",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1234567890000);
        const root = yield* fixture;
        const configurations: unknown[] = [];
        let sampleCalls = 0;
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(0);
          const sessionPath = join(
            root,
            "chromium-performance-recordings",
            `lucent-chromium-recording-2009-02-13T23-31-30-000Z-${process.pid}`,
          );
          const initialSamples = yield* readSamples(sessionPath);
          expect(initialSamples).toEqual([
            {
              capturedAt: "2009-02-13T23:31:30.000Z",
              elapsedMs: 0,
              processes: [
                {
                  cpuPercent: 5,
                  creationTime: 123,
                  idleWakeupsPerSecond: 2,
                  peakWorkingSetKiB: 200,
                  pid: 10,
                  privateMemoryKiB: 75,
                  type: "Browser",
                  workingSetKiB: 100,
                },
              ],
            },
          ]);
          yield* TestClock.adjust(2500);
          expect(yield* readSamples(sessionPath)).toHaveLength(3);
          const saved = yield* recording.stop;
          expect(yield* Effect.promise(() => readdir(sessionPath))).toEqual([
            "manifest.json",
            "metrics.jsonl",
            "trace.json",
          ]);
          expect(yield* readJson(join(sessionPath, "trace.json"))).toEqual({
            traceEvents: [],
          });
          const manifest = yield* readJson(saved!.manifestPath);
          expect(manifest).toMatchObject({
            availableCategoriesAtStart: ["v8", "electron"],
            durationMs: 2500,
            failedMetricsAppendCount: 0,
            mainResourceSampleIntervalMs: 1000,
            metadata: { appVersion: "1.0.0", isDev: false },
            resourceSampleCount: 3,
            resourceSamplesFileName: "metrics.jsonl",
          });
          expect(manifest).not.toHaveProperty("resourceSamples");
          const samples = yield* readSamples(sessionPath);
          expect(
            samples.map((sample: { elapsedMs: number }) => sample.elapsedMs),
          ).toEqual([0, 1000, 2000]);
          expect(samples[0]).toEqual(initialSamples[0]);
          yield* TestClock.adjust(10000);
          expect(sampleCalls).toBe(4);
          expect(configurations).toHaveLength(1);
          expect(configurations[0]).toMatchObject({
            excluded_categories: ["*"],
            recording_mode: "record-continuously",
            trace_buffer_size_in_kb: 262144,
          });
        }).pipe(
          Effect.provide(
            services(
              root,
              {
                startRecording: (config) =>
                  Effect.sync(() => {
                    configurations.push(config);
                  }),
              },
              Effect.sync(() => {
                sampleCalls++;
                return [sampleMetric];
              }),
            ),
          ),
        );
      }),
  );

  it.effect(
    "counts failed metrics appends and warns once while continuing",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1234567890000);
        const root = yield* fixture;
        let appends = 0;
        const records: {
          annotations: Readonly<Record<string, unknown>>;
          level: string;
          message: unknown;
        }[] = [];
        const logger = Logger.make((options) => {
          records.push({
            annotations: options.fiber.getRef(References.CurrentLogAnnotations),
            level: options.logLevel,
            message: options.message,
          });
        });
        const failingFileSystem = Layer.effect(
          FileSystem,
          Effect.map(
            FileSystem,
            (fileSystem): FileSystem => ({
              ...fileSystem,
              writeFileString: (path, data, options) =>
                Effect.suspend(() =>
                  options?.flag === "a" && ++appends > 1
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "writeFileString",
                          description: "No space left on device",
                        }),
                      )
                    : fileSystem.writeFileString(path, data, options),
                ),
            }),
          ),
        ).pipe(Layer.provide(fileSystemLayer));
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(1000);
          const warningsAfterFirstFailure = records.filter(
            ({ level }) => level === "Warn",
          ).length;
          yield* TestClock.adjust(1500);
          expect(yield* recording.getState).toEqual({
            status: "recording",
            startedAt: "2009-02-13T23:31:30.000Z",
          });
          const saved = yield* recording.stop;
          const manifest = yield* readJson(saved!.manifestPath);
          expect(appends).toBe(3);
          expect(
            yield* Effect.promise(() =>
              readFile(
                join(dirname(saved!.manifestPath), "metrics.jsonl"),
                "utf8",
              ),
            ),
          ).toBe(
            '{"capturedAt":"2009-02-13T23:31:30.000Z","elapsedMs":0,"processes":[]}\n',
          );
          expect({
            failedMetricsAppendCount: manifest.failedMetricsAppendCount,
            resourceSampleCount: manifest.resourceSampleCount,
            warningsAfterFirstFailure,
            warnings: records.filter(({ level }) => level === "Warn"),
          }).toEqual({
            failedMetricsAppendCount: 2,
            resourceSampleCount: 1,
            warningsAfterFirstFailure: 1,
            warnings: [
              {
                annotations: {
                  component: "chromium-performance-recording",
                  data: {
                    sessionName: `lucent-chromium-recording-2009-02-13T23-31-30-000Z-${process.pid}`,
                  },
                },
                level: "Warn",
                message: ["Failed to append performance trace metrics"],
              },
            ],
          });
          expect(yield* recording.getState).toEqual({ status: "idle" });
        }).pipe(
          Effect.provide(
            services(root, {}, Effect.succeed([]), failingFileSystem),
          ),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
      }),
  );

  it.effect(
    "retains the start manifest and samples after a crash without saving",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1234567890000);
        const root = yield* fixture;
        const scope = yield* Scope.make();
        let cleanup = Scope.close(scope, Exit.void);
        let stops = 0;
        try {
          const context = yield* Layer.buildWithScope(
            services(root, {
              stopRecording: (path) =>
                Effect.sync(() => {
                  stops++;
                  return path;
                }),
            }),
            scope,
          );
          yield* Effect.gen(function* () {
            const recording = yield* DesktopChromiumPerformanceRecording;
            yield* recording.start;
            yield* TestClock.adjust(2500);
          }).pipe(Effect.provide(context));
          cleanup = Scope.closeUnsafe(scope, Exit.void) ?? Effect.void;
          const sessionPath = join(
            root,
            "chromium-performance-recordings",
            `lucent-chromium-recording-2009-02-13T23-31-30-000Z-${process.pid}`,
          );
          expect(stops).toBe(0);
          expect(yield* Effect.promise(() => readdir(sessionPath))).toEqual([
            "manifest.json",
            "metrics.jsonl",
          ]);
          const manifest = yield* readJson(join(sessionPath, "manifest.json"));
          expect(manifest).toMatchObject({
            availableCategoriesAtStart: ["v8", "electron"],
            heapCheckpoints: [],
            mainResourceSampleIntervalMs: 1000,
            metadata: { appVersion: "1.0.0", isDev: false },
            resourceSampleCount: 0,
            resourceSamplesFileName: "metrics.jsonl",
            schemaVersion: 4,
            startedAt: "2009-02-13T23:31:30.000Z",
            status: "recording",
            trace: {
              fileName: "trace.json",
              status: "recording",
              recordingMode: "record-continuously",
              bufferSizeKiB: 262144,
            },
          });
          expect(manifest).not.toHaveProperty("endedAt");
          expect(manifest).not.toHaveProperty("durationMs");
          expect(manifest).not.toHaveProperty("resourceSamples");
          expect(yield* readSamples(sessionPath)).toEqual([
            {
              capturedAt: "2009-02-13T23:31:30.000Z",
              elapsedMs: 0,
              processes: [],
            },
            {
              capturedAt: "2009-02-13T23:31:31.000Z",
              elapsedMs: 1000,
              processes: [],
            },
            {
              capturedAt: "2009-02-13T23:31:32.000Z",
              elapsedMs: 2000,
              processes: [],
            },
          ]);
        } finally {
          yield* cleanup;
        }
      }),
  );

  it.effect(
    "continues process sampling across long recordings without restarting tracing",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        let starts = 0;
        let stops = 0;
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(121000);
          expect(starts).toBe(1);
          expect(stops).toBe(0);
          const saved = yield* recording.stop;
          expect(yield* readJson(saved!.manifestPath)).toMatchObject({
            durationMs: 121000,
            resourceSampleCount: 122,
          });
          expect(stops).toBe(1);
        }).pipe(
          Effect.provide(
            services(root, {
              startRecording: () =>
                Effect.sync(() => {
                  starts++;
                }),
              stopRecording: (path) =>
                Effect.sync(() => {
                  stops++;
                  return path;
                }),
            }),
          ),
        );
      }),
  );

  it.effect(
    "captures registered application renderers with window kinds and retains partial failures",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const rendererPaths: string[] = [];
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          const checkpoint = yield* recording.captureHeapSnapshot;
          expect(checkpoint).toMatchObject({
            failedSnapshotCount: 1,
            snapshotCount: 3,
          });
          expect(rendererPaths.map((path) => basename(path))).toEqual([
            "renderer-1.heapsnapshot",
            "renderer-2.heapsnapshot",
          ]);
          expect(yield* recording.getState).toMatchObject({
            status: "recording",
          });
          const saved = yield* recording.stop;
          const manifest = yield* readJson(saved!.manifestPath);
          expect(
            yield* Effect.promise(() =>
              readdir(
                join(
                  dirname(saved!.manifestPath),
                  "heap-snapshots",
                  manifest.heapCheckpoints[0].directoryName,
                ),
              ),
            ),
          ).toEqual(["main.heapsnapshot", "renderer-2.heapsnapshot"]);
          expect(manifest.heapCheckpoints[0].snapshots).toEqual([
            {
              fileName: "main.heapsnapshot",
              kind: "main",
              osProcessId: process.pid,
              status: "saved",
            },
            {
              rendererId: 1,
              fileName: "renderer-1.heapsnapshot",
              kind: "renderer",
              windowKind: "game",
              osProcessId: 11,
              status: "failed",
              error:
                "Electron Chromium performance operation failed: take-renderer-heap-snapshot:1.",
            },
            {
              rendererId: 2,
              fileName: "renderer-2.heapsnapshot",
              kind: "renderer",
              windowKind: "settings",
              osProcessId: 12,
              status: "saved",
            },
          ]);
        }).pipe(
          Effect.provide(
            services(root, {
              getRendererTargets: Effect.succeed([
                { rendererId: 1, osProcessId: 11 },
                { rendererId: 2, osProcessId: 12 },
                { rendererId: 3, osProcessId: 13 },
                { rendererId: 4, osProcessId: 14 },
                { rendererId: 5, osProcessId: 15 },
              ]),
              takeRendererHeapSnapshot: (id, path) =>
                Effect.gen(function* () {
                  rendererPaths.push(path);
                  if (id === 1)
                    return yield* nativeFailure(
                      "take-renderer-heap-snapshot:1",
                    );
                  return yield* saveSnapshot(path);
                }),
            }),
          ),
        );
      }),
  );

  it.effect("serializes stop behind a pending heap snapshot", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      let stopped = false;
      const snapshotStarted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        yield* recording.start;
        const snapshot = yield* recording.captureHeapSnapshot.pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(snapshotStarted);
        yield* TestClock.adjust(100);
        expect(yield* recording.getState).toMatchObject({
          status: "snapshotting",
        });
        const stop = yield* recording.stop.pipe(Effect.forkChild);
        yield* TestClock.adjust(100);
        expect(stopped).toBe(false);
        yield* TestClock.adjust(800);
        expect(yield* Fiber.join(snapshot)).toMatchObject({
          snapshotCount: 1,
          failedSnapshotCount: 0,
        });
        const saved = yield* Fiber.join(stop);
        expect(yield* readJson(saved!.manifestPath)).toMatchObject({
          durationMs: 1000,
          heapCheckpoints: [{ index: 0 }],
        });
        expect(stopped).toBe(true);
      }).pipe(
        Effect.provide(
          services(root, {
            takeMainHeapSnapshot: () =>
              Deferred.succeed(snapshotStarted, undefined).pipe(
                Effect.andThen(Effect.sleep(1000)),
              ),
            stopRecording: (path) =>
              Effect.sync(() => {
                stopped = true;
                return path;
              }),
          }),
        ),
      );
    }),
  );

  it.effect("leaves startup failures idle and permits another recording", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      let attempts = 0;
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        expect(yield* recording.start.pipe(Effect.flip)).toMatchObject({
          _tag: "DesktopChromiumPerformanceRecordingError",
          message: "Failed to start the Chromium performance recording.",
        });
        expect(yield* recording.getState).toEqual({ status: "idle" });
        expect(
          yield* Effect.promise(() =>
            readdir(join(root, "chromium-performance-recordings")),
          ),
        ).toEqual([]);
        yield* recording.start;
        expect(yield* recording.getState).toMatchObject({
          status: "recording",
        });
        const saved = yield* recording.stop;
        expect(yield* readJson(saved!.manifestPath)).toMatchObject({
          durationMs: 0,
        });
      }).pipe(
        Effect.provide(
          services(root, {
            startRecording: () =>
              Effect.suspend(() =>
                ++attempts === 1
                  ? Effect.fail(nativeFailure("start-recording"))
                  : Effect.void,
              ),
          }),
        ),
      );
    }),
  );

  it.effect("preserves metrics when saving the trace fails", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        yield* recording.start;
        yield* TestClock.adjust(1000);
        const saved = yield* recording.stop;
        expect(yield* readJson(saved!.manifestPath)).toMatchObject({
          status: "complete",
          trace: {
            status: "failed",
            fileName: "trace.json",
            error:
              "Electron Chromium performance operation failed: stop-recording.",
          },
          resourceSampleCount: 2,
          resourceSamplesFileName: "metrics.jsonl",
        });
        expect(
          (yield* readSamples(dirname(saved!.manifestPath))).map(
            (sample) => sample.elapsedMs,
          ),
        ).toEqual([0, 1000]);
        expect(yield* recording.getState).toEqual({ status: "idle" });
      }).pipe(
        Effect.provide(
          services(root, {
            stopRecording: () => Effect.fail(nativeFailure("stop-recording")),
          }),
        ),
      );
    }),
  );

  it.effect(
    "returns to idle and stops sampling when the manifest cannot be saved",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        let samples = 0;
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          yield* TestClock.adjust(1000);
          yield* Effect.promise(() =>
            rm(root, { recursive: true, force: true }),
          );
          expect(yield* recording.stop.pipe(Effect.flip)).toMatchObject({
            _tag: "DesktopChromiumPerformanceRecordingError",
          });
          expect(yield* recording.getState).toEqual({ status: "idle" });
          yield* TestClock.adjust(1000);
          expect(samples).toBe(3);
          yield* recording.start;
          yield* TestClock.adjust(1);
          const saved = yield* recording.stop;
          expect(yield* readJson(saved!.manifestPath)).toMatchObject({
            durationMs: 1,
          });
        }).pipe(
          Effect.provide(
            services(
              root,
              {
                stopRecording: (path) => Effect.succeed(path),
              },
              Effect.sync(() => {
                samples++;
                return [];
              }),
            ),
          ),
        );
      }),
  );

  it.effect("continues sampling after an unavailable metrics sample", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      let calls = 0;
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        yield* recording.start;
        yield* TestClock.adjust(2500);
        const saved = yield* recording.stop;
        expect(yield* readJson(saved!.manifestPath)).toMatchObject({
          resourceSampleCount: 2,
          resourceSamplesFileName: "metrics.jsonl",
        });
        expect(
          (yield* readSamples(dirname(saved!.manifestPath))).map(
            (sample) => sample.elapsedMs,
          ),
        ).toEqual([1000, 2000]);
      }).pipe(
        Effect.provide(
          services(
            root,
            {},
            Effect.suspend(() =>
              ++calls === 2
                ? Effect.die(new Error("Metrics unavailable"))
                : Effect.succeed([]),
            ),
          ),
        ),
      );
    }),
  );

  for (const failure of ["trace", "manifest", "trace-and-manifest"] as const) {
    it.effect(`logs one warning when shutdown cannot save the ${failure}`, () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const records: { level: string; message: unknown }[] = [];
        const logger = Logger.make((options) => {
          records.push({ level: options.logLevel, message: options.message });
        });
        yield* Effect.gen(function* () {
          const recording = yield* DesktopChromiumPerformanceRecording;
          yield* recording.start;
          if (failure !== "trace") {
            yield* Effect.promise(() =>
              rm(root, { recursive: true, force: true }),
            );
          }
        }).pipe(
          Effect.provide(
            services(root, {
              stopRecording: (path) =>
                failure === "manifest"
                  ? Effect.succeed(path)
                  : Effect.fail(nativeFailure("stop-recording")),
            }),
          ),
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(records.filter(({ level }) => level === "Warn")).toEqual([
          {
            level: "Warn",
            message: [
              "Failed to save Chromium performance recording during shutdown",
            ],
          },
        ]);
      }),
    );
  }

  it.effect("saves on shutdown and interrupts a pending process sample", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      let cancelled = false;
      let metricCalls = 0;
      let tracePath = "";
      yield* Effect.gen(function* () {
        const recording = yield* DesktopChromiumPerformanceRecording;
        yield* recording.start;
        yield* TestClock.adjust(2500);
      }).pipe(
        Effect.provide(
          services(
            root,
            {
              stopRecording: (path) =>
                Effect.sync(() => {
                  tracePath = path;
                  return path;
                }),
            },
            Effect.suspend(() =>
              ++metricCalls === 1
                ? Effect.succeed([])
                : Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        cancelled = true;
                      }),
                    ),
                  ),
            ),
          ),
        ),
      );
      expect(cancelled).toBe(true);
      expect(basename(tracePath)).toBe("trace.json");
      expect(
        yield* readJson(join(tracePath, "..", "manifest.json")),
      ).toMatchObject({
        status: "complete",
        durationMs: 2500,
        resourceSampleCount: 0,
        resourceSamplesFileName: "metrics.jsonl",
      });
      expect(yield* readSamples(dirname(tracePath))).toEqual([]);
    }),
  );
});
