import { cpus, totalmem } from "node:os";
import { basename, join } from "node:path";

import type { ProcessMetric } from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ElectronApp } from "../../electron/ElectronApp";
import { ElectronChromiumPerformance } from "../../electron/ElectronChromiumPerformance";
import { makeAtomicFile } from "../../filesystem/AtomicFile";
import { DesktopWindows } from "../../window/DesktopWindows";
import type { DesktopWindowKind } from "../../window/DesktopWindowCatalog";
import { DesktopEnvironment } from "../DesktopEnvironment";
import { makeListenerRegistry } from "../ListenerRegistry";

const CHROMIUM_TRACE_BUFFER_SIZE_KIB = 256 * 1024;
const CHROMIUM_RESOURCE_SAMPLE_INTERVAL_MS = 1_000;
const CHROMIUM_PERFORMANCE_TRACE_CATEGORIES = [
  "blink.console",
  "blink.user_timing",
  "cc",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "electron",
  "gpu",
  "ipc",
  "latencyInfo",
  "loading",
  "navigation",
  "renderer.scheduler",
  "sequence_manager",
  "toplevel",
  "v8",
  "v8.execute",
  "viz",
] as const;

const chromiumRecordingTimestamp = (timestamp: string): string =>
  timestamp.replace(/[:.]/g, "-");

interface ChromiumProcessSample {
  readonly cpuPercent: number;
  readonly creationTime: number;
  readonly idleWakeupsPerSecond: number;
  readonly name?: string;
  readonly peakWorkingSetKiB: number;
  readonly pid: number;
  readonly privateMemoryKiB?: number;
  readonly type: ProcessMetric["type"];
  readonly workingSetKiB: number;
}

const normalizeChromiumProcessMetric = (
  metric: ProcessMetric,
): ChromiumProcessSample => ({
  cpuPercent: metric.cpu.percentCPUUsage,
  creationTime: metric.creationTime,
  idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
  ...(metric.name === undefined ? {} : { name: metric.name }),
  peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
  pid: metric.pid,
  ...(metric.memory.privateBytes === undefined
    ? {}
    : { privateMemoryKiB: metric.memory.privateBytes }),
  type: metric.type,
  workingSetKiB: metric.memory.workingSetSize,
});

const TRACE_FILE_NAME = "trace.json";
const MANIFEST_FILE_NAME = "manifest.json";
const METRICS_FILE_NAME = "metrics.jsonl";
const HEAP_SNAPSHOTS_DIRECTORY_NAME = "heap-snapshots";

export type DesktopChromiumPerformanceRecordingState =
  | { readonly status: "idle" }
  | {
      readonly startedAt: string;
      readonly status: "recording" | "snapshotting" | "saving";
    };

export interface DesktopChromiumHeapSnapshotResult {
  readonly failedSnapshotCount: number;
  readonly snapshotCount: number;
}

export interface DesktopChromiumPerformanceRecordingResult {
  readonly manifestPath: string;
}

export class DesktopChromiumPerformanceRecordingError extends Schema.TaggedError<DesktopChromiumPerformanceRecordingError>()(
  "DesktopChromiumPerformanceRecordingError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface DesktopChromiumPerformanceRecordingShape {
  readonly captureHeapSnapshot: Effect.Effect<
    DesktopChromiumHeapSnapshotResult,
    DesktopChromiumPerformanceRecordingError
  >;
  readonly getState: Effect.Effect<DesktopChromiumPerformanceRecordingState>;
  readonly onChanged: (
    listener: (state: DesktopChromiumPerformanceRecordingState) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly start: Effect.Effect<void, DesktopChromiumPerformanceRecordingError>;
  readonly stop: Effect.Effect<
    DesktopChromiumPerformanceRecordingResult | undefined,
    DesktopChromiumPerformanceRecordingError
  >;
}

export class DesktopChromiumPerformanceRecording extends Context.Service<
  DesktopChromiumPerformanceRecording,
  DesktopChromiumPerformanceRecordingShape
>()("lucent/desktop/app/observability/DesktopChromiumPerformanceRecording") {}

interface ChromiumHeapSnapshotArtifact {
  readonly rendererId?: number;
  readonly error?: string;
  readonly fileName: string;
  readonly kind: "main" | "renderer";
  readonly osProcessId: number;
  readonly status: "failed" | "saved";
  readonly windowKind?: DesktopWindowKind;
}

interface ChromiumHeapCheckpoint {
  readonly directoryName: string;
  readonly endedAt: string;
  readonly index: number;
  readonly snapshots: readonly ChromiumHeapSnapshotArtifact[];
  readonly startedAt: string;
}

interface ActiveChromiumPerformanceRecording {
  readonly availableCategoriesAtStart: readonly string[];
  failedResourceSampleCount: number;
  readonly heapCheckpoints: ChromiumHeapCheckpoint[];
  readonly metadata: {
    readonly appVersion: string;
    readonly architecture: string;
    readonly cpuModel: string | null;
    readonly isDev: boolean;
    readonly logicalCpuCount: number;
    readonly platform: NodeJS.Platform;
    readonly runtimeVersions: {
      readonly chrome: string;
      readonly electron: string;
      readonly node: string;
    };
    readonly totalSystemMemoryBytes: number;
  };
  resourceSampleCount: number;
  readonly sampler: Fiber.Fiber<unknown>;
  readonly sessionPath: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  status: "recording" | "snapshotting" | "saving";
}

const snapshotArtifact = <Error>(
  effect: Effect.Effect<void, Error>,
  artifact: Omit<ChromiumHeapSnapshotArtifact, "error" | "status">,
): Effect.Effect<ChromiumHeapSnapshotArtifact> =>
  effect.pipe(
    Effect.as({ ...artifact, status: "saved" as const }),
    Effect.catch((cause) =>
      Effect.succeed({
        ...artifact,
        error: cause instanceof Error ? cause.message : String(cause),
        status: "failed" as const,
      }),
    ),
  );

const makeDesktopChromiumPerformanceRecording = Effect.gen(function* () {
  const chromium = yield* ElectronChromiumPerformance;
  const electronApp = yield* ElectronApp;
  const env = yield* DesktopEnvironment;
  const fileSystem = yield* FileSystem;
  const windows = yield* DesktopWindows;
  const atomicFile = makeAtomicFile(fileSystem);
  const gate = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const changes =
    makeListenerRegistry<DesktopChromiumPerformanceRecordingState>();
  const recordingsRoot = join(
    env.appDataDir,
    "chromium-performance-recordings",
  );
  let active: ActiveChromiumPerformanceRecording | undefined;

  const getState = Effect.sync(
    (): DesktopChromiumPerformanceRecordingState =>
      active === undefined
        ? { status: "idle" }
        : { startedAt: active.startedAt, status: active.status },
  );
  const publishState = getState.pipe(Effect.flatMap(changes.publish));

  const writeManifest = (
    current: Omit<ActiveChromiumPerformanceRecording, "sampler">,
    endedAtMs?: number,
    trace: {
      readonly status: "recording" | "saved" | "failed";
      readonly error?: string;
    } = { status: "recording" },
  ) =>
    atomicFile.writeToExistingParent(
      join(current.sessionPath, MANIFEST_FILE_NAME),
      `${JSON.stringify(
        {
          availableCategoriesAtStart: current.availableCategoriesAtStart,
          ...(endedAtMs === undefined
            ? {}
            : {
                durationMs: Math.max(0, endedAtMs - current.startedAtMs),
                endedAt: DateTime.formatIso(DateTime.makeUnsafe(endedAtMs)),
              }),
          failedResourceSampleCount: current.failedResourceSampleCount,
          heapCheckpoints: current.heapCheckpoints,
          mainResourceSampleIntervalMs: CHROMIUM_RESOURCE_SAMPLE_INTERVAL_MS,
          metadata: current.metadata,
          resourceSampleCount: current.resourceSampleCount,
          resourceSamplesFileName: METRICS_FILE_NAME,
          schemaVersion: 4,
          startedAt: current.startedAt,
          status: endedAtMs === undefined ? "recording" : "complete",
          trace: {
            fileName: TRACE_FILE_NAME,
            ...trace,
            bufferSizeKiB: CHROMIUM_TRACE_BUFFER_SIZE_KIB,
            categories: CHROMIUM_PERFORMANCE_TRACE_CATEGORIES,
            excludedCategories: ["*"],
            recordingMode: "record-continuously",
          },
        },
        null,
        2,
      )}\n`,
    );

  const start = gate.withPermits(1)(
    Effect.gen(function* () {
      if (active !== undefined) {
        return yield* new DesktopChromiumPerformanceRecordingError({
          message: "A performance trace is already recording.",
        });
      }

      yield* electronApp.getAppMetrics;
      const appVersion = yield* electronApp.getVersion;
      const availableCategoriesAtStart = yield* chromium.getCategories;
      const startedAtMs = yield* Clock.currentTimeMillis;
      const startedAt = DateTime.formatIso(DateTime.makeUnsafe(startedAtMs));
      const sessionPath = join(
        recordingsRoot,
        `lucent-chromium-recording-${chromiumRecordingTimestamp(startedAt)}-${process.pid}`,
      );
      yield* fileSystem.makeDirectory(recordingsRoot, { recursive: true });
      yield* fileSystem.makeDirectory(sessionPath);
      const cpuList = cpus();
      const metadata = {
        appVersion,
        architecture: process.arch,
        cpuModel: cpuList[0]?.model ?? null,
        isDev: env.isDev,
        logicalCpuCount: cpuList.length,
        platform: env.platform,
        runtimeVersions: {
          chrome: process.versions.chrome ?? "unknown",
          electron: process.versions.electron ?? "unknown",
          node: process.versions.node,
        },
        totalSystemMemoryBytes: totalmem(),
      };
      const current: Omit<ActiveChromiumPerformanceRecording, "sampler"> = {
        availableCategoriesAtStart,
        failedResourceSampleCount: 0,
        heapCheckpoints: [],
        metadata,
        resourceSampleCount: 0,
        sessionPath,
        startedAt,
        startedAtMs,
        status: "recording",
      };
      const metricsPath = join(sessionPath, METRICS_FILE_NAME);
      yield* Effect.gen(function* () {
        yield* fileSystem.writeFileString(metricsPath, "");
        yield* writeManifest(current);
        yield* chromium.startRecording({
          excluded_categories: ["*"],
          included_categories: [...CHROMIUM_PERFORMANCE_TRACE_CATEGORIES],
          recording_mode: "record-continuously",
          trace_buffer_size_in_kb: CHROMIUM_TRACE_BUFFER_SIZE_KIB,
        });
      }).pipe(
        Effect.onError(() =>
          fileSystem
            .remove(sessionPath, { recursive: true })
            .pipe(Effect.ignore),
        ),
      );
      const recordSampleFailure = Effect.fnUntraced(function* (
        cause: Cause.Cause<unknown>,
      ) {
        if (Cause.hasInterrupts(cause)) {
          return yield* Effect.interrupt;
        }
        if (++current.failedResourceSampleCount === 1) {
          yield* Effect.logWarning(
            "Failed to record performance trace metrics",
            cause,
          ).pipe(
            Effect.annotateLogs({
              component: "chromium-performance-recording",
              data: { sessionName: basename(sessionPath) },
            }),
          );
        }
      });
      const sampler = yield* Effect.gen(function* () {
        const metrics = yield* electronApp.getAppMetrics;
        const capturedAtMs = yield* Clock.currentTimeMillis;
        yield* fileSystem
          .writeFileString(
            metricsPath,
            `${JSON.stringify({
              capturedAt: DateTime.formatIso(DateTime.makeUnsafe(capturedAtMs)),
              elapsedMs: Math.max(0, capturedAtMs - startedAtMs),
              processes: metrics.map(normalizeChromiumProcessMetric),
            })}\n`,
            { flag: "a" },
          )
          .pipe(
            Effect.andThen(Effect.sync(() => current.resourceSampleCount++)),
            Effect.catchCause(recordSampleFailure),
            Effect.uninterruptible,
          );
      }).pipe(
        Effect.catchCause(recordSampleFailure),
        Effect.repeat(Schedule.spaced(CHROMIUM_RESOURCE_SAMPLE_INTERVAL_MS)),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
      active = Object.assign(current, { sampler });
      yield* publishState;
      yield* Effect.logInfo("Performance trace started").pipe(
        Effect.annotateLogs({
          component: "chromium-performance-recording",
          data: { sessionName: basename(sessionPath) },
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "DesktopChromiumPerformanceRecordingError"
          ? cause
          : new DesktopChromiumPerformanceRecordingError({
              cause,
              message: "Failed to start the performance trace.",
            }),
      ),
      Effect.uninterruptible,
    ),
  );

  const captureHeapSnapshot = gate.withPermits(1)(
    Effect.gen(function* () {
      const current = active;
      if (current === undefined) {
        return yield* new DesktopChromiumPerformanceRecordingError({
          message: "No performance trace is active.",
        });
      }
      current.status = "snapshotting";
      yield* publishState;
      return yield* Effect.gen(function* () {
        const startedAt = (yield* DateTime.nowAsDate).toISOString();
        const index = current.heapCheckpoints.length;
        const directoryName = `checkpoint-${String(index).padStart(3, "0")}-${chromiumRecordingTimestamp(startedAt)}`;
        const checkpointPath = join(
          current.sessionPath,
          HEAP_SNAPSHOTS_DIRECTORY_NAME,
          directoryName,
        );
        yield* fileSystem.makeDirectory(checkpointPath, { recursive: true });
        const main = yield* snapshotArtifact(
          chromium.takeMainHeapSnapshot(
            join(checkpointPath, "main.heapsnapshot"),
          ),
          {
            fileName: "main.heapsnapshot",
            kind: "main",
            osProcessId: process.pid,
          },
        );
        const snapshots = [main];
        const targets = yield* chromium.getRendererTargets;
        for (const target of targets) {
          const info = yield* windows.describe(target.rendererId);
          if (
            info === undefined ||
            info.kind === "game-host" ||
            info.kind === "game-group-controls"
          ) {
            continue;
          }
          const fileName = `renderer-${target.rendererId}.heapsnapshot`;
          snapshots.push(
            yield* snapshotArtifact(
              chromium.takeRendererHeapSnapshot(
                target.rendererId,
                join(checkpointPath, fileName),
              ),
              {
                rendererId: target.rendererId,
                fileName,
                kind: "renderer",
                osProcessId: target.osProcessId,
                windowKind: info.kind,
              },
            ),
          );
        }
        current.heapCheckpoints.push({
          directoryName,
          endedAt: (yield* DateTime.nowAsDate).toISOString(),
          index,
          snapshots,
          startedAt,
        });
        return {
          failedSnapshotCount: snapshots.filter(
            (snapshot) => snapshot.status === "failed",
          ).length,
          snapshotCount: snapshots.length,
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopChromiumPerformanceRecordingError({
              cause,
              message: "Failed to save the Chromium heap checkpoint.",
            }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            current.status = "recording";
            yield* publishState;
          }),
        ),
      );
    }),
  );

  const stop = gate.withPermits(1)(
    Effect.gen(function* () {
      const current = active;
      if (current === undefined) {
        return undefined;
      }
      current.status = "saving";
      yield* publishState;
      return yield* Effect.gen(function* () {
        yield* Fiber.interrupt(current.sampler);
        const traceError = yield* chromium
          .stopRecording(join(current.sessionPath, TRACE_FILE_NAME))
          .pipe(Effect.as(undefined), Effect.catch(Effect.succeed));
        const endedAtMs = yield* Clock.currentTimeMillis;
        const manifestPath = join(current.sessionPath, MANIFEST_FILE_NAME);
        yield* writeManifest(
          current,
          endedAtMs,
          traceError === undefined
            ? { status: "saved" }
            : { status: "failed", error: traceError.message },
        );
        if (traceError !== undefined) {
          return yield* traceError;
        }
        yield* Effect.logInfo("Performance trace saved").pipe(
          Effect.annotateLogs({
            component: "chromium-performance-recording",
            data: { sessionName: basename(current.sessionPath) },
          }),
        );
        return { manifestPath };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopChromiumPerformanceRecordingError({
              cause,
              message: `Failed to save the performance trace to ${current.sessionPath}.`,
            }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            active = undefined;
            yield* publishState;
          }),
        ),
      );
    }).pipe(Effect.uninterruptible),
  );

  yield* Effect.addFinalizer(() =>
    stop.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Failed to save performance trace during shutdown",
          cause,
        ).pipe(
          Effect.annotateLogs({ component: "chromium-performance-recording" }),
        ),
      ),
    ),
  );

  return DesktopChromiumPerformanceRecording.of({
    captureHeapSnapshot,
    getState,
    onChanged: changes.subscribe,
    start,
    stop: stop.pipe(
      Effect.onError((cause) =>
        Effect.logWarning("Failed to save performance trace", cause).pipe(
          Effect.annotateLogs({ component: "chromium-performance-recording" }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(
  DesktopChromiumPerformanceRecording,
  makeDesktopChromiumPerformanceRecording,
);
