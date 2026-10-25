import {
  contentTracing,
  webContents,
  type TraceConfig,
  type WebContents,
} from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ElectronChromiumRendererTarget {
  readonly rendererId: number;
  readonly osProcessId: number;
}

export class ElectronChromiumPerformanceError extends Schema.TaggedError<ElectronChromiumPerformanceError>()(
  "ElectronChromiumPerformanceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron Chromium performance operation failed: ${this.operation}.`;
  }
}

export interface ElectronChromiumPerformanceShape {
  readonly getCategories: Effect.Effect<
    readonly string[],
    ElectronChromiumPerformanceError
  >;
  readonly getRendererTargets: Effect.Effect<
    readonly ElectronChromiumRendererTarget[]
  >;
  readonly startRecording: (
    config: TraceConfig,
  ) => Effect.Effect<void, ElectronChromiumPerformanceError>;
  readonly stopRecording: (
    filePath: string,
  ) => Effect.Effect<string, ElectronChromiumPerformanceError>;
  readonly takeMainHeapSnapshot: (
    filePath: string,
  ) => Effect.Effect<void, ElectronChromiumPerformanceError>;
  readonly takeRendererHeapSnapshot: (
    rendererId: number,
    filePath: string,
  ) => Effect.Effect<void, ElectronChromiumPerformanceError>;
}

export class ElectronChromiumPerformance extends Context.Service<
  ElectronChromiumPerformance,
  ElectronChromiumPerformanceShape
>()("lucent/desktop/electron/ElectronChromiumPerformance") {}

const rendererWebContents = (rendererId: number): WebContents => {
  const renderer = webContents.fromId(rendererId);
  if (renderer === undefined || renderer.isDestroyed()) {
    throw new Error(`Electron renderer is not available: ${rendererId}`);
  }
  return renderer;
};

const chromiumPerformance = ElectronChromiumPerformance.of({
  getCategories: Effect.tryPromise({
    try: () => contentTracing.getCategories(),
    catch: (cause) =>
      new ElectronChromiumPerformanceError({
        cause,
        operation: "get-categories",
      }),
  }),
  getRendererTargets: Effect.sync(() =>
    webContents.getAllWebContents().flatMap((renderer) => {
      if (renderer.isDestroyed()) {
        return [];
      }
      return [
        {
          rendererId: renderer.id,
          osProcessId: renderer.getOSProcessId(),
        },
      ];
    }),
  ),
  startRecording: (config) =>
    Effect.tryPromise({
      try: () => contentTracing.startRecording(config),
      catch: (cause) =>
        new ElectronChromiumPerformanceError({
          cause,
          operation: "start-recording",
        }),
    }),
  stopRecording: (filePath) =>
    Effect.tryPromise({
      try: () => contentTracing.stopRecording(filePath),
      catch: (cause) =>
        new ElectronChromiumPerformanceError({
          cause,
          operation: "stop-recording",
        }),
    }),
  takeMainHeapSnapshot: (filePath) =>
    Effect.try({
      try: () => {
        if (!process.takeHeapSnapshot(filePath)) {
          throw new Error("Electron did not create the main heap snapshot.");
        }
      },
      catch: (cause) =>
        new ElectronChromiumPerformanceError({
          cause,
          operation: "take-main-heap-snapshot",
        }),
    }),
  takeRendererHeapSnapshot: (rendererId, filePath) =>
    Effect.tryPromise({
      try: () => rendererWebContents(rendererId).takeHeapSnapshot(filePath),
      catch: (cause) =>
        new ElectronChromiumPerformanceError({
          cause,
          operation: `take-renderer-heap-snapshot:${rendererId}`,
        }),
    }),
});

export const layer = Layer.succeed(
  ElectronChromiumPerformance,
  chromiumPerformance,
);
