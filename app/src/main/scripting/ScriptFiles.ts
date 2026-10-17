import { join, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";

import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as FiberSet from "effect/FiberSet";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as RcRef from "effect/RcRef";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { RpcClient } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/rpc/RpcMessage";
import {
  WorkerReceiveError,
  WorkerSendError,
} from "effect/workers/WorkerError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  ScriptFile,
  ScriptFileResolution,
} from "@lucent/core/scriptInputs";
import { listen } from "../electron/NativeListener";
import { logFailure } from "../../shared/logFailure";
import {
  SCRIPT_FILE_WORKER_HEAP_MB,
  SCRIPT_FILE_WORKER_QUEUE_LIMIT,
  SCRIPT_FILE_WORKER_TIMEOUT_MS,
  type ScriptFileAnalysis,
  type ScriptFileAnalysisResolution,
  ScriptFileWorkerRpcs,
} from "./ScriptFileWorkerProtocol";

const isRpcClientError = Schema.is(RpcClientError);

export class ScriptFilesError extends Schema.TaggedError<ScriptFilesError>()(
  "ScriptFilesError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    failureCause: Schema.optionalKey(
      Schema.Cause(Schema.Defect(), Schema.Defect()),
    ),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScriptFilesShape {
  readonly analyze: (
    path: string,
  ) => Effect.Effect<ScriptFileAnalysis, ScriptFilesError>;
  readonly read: (path: string) => Effect.Effect<ScriptFile, ScriptFilesError>;
  readonly resolve: (path: string) => Effect.Effect<ScriptFileResolution>;
}

export class ScriptFiles extends Context.Service<
  ScriptFiles,
  ScriptFilesShape
>()("lucent/desktop/scripting/ScriptFiles") {}

export const makeScriptFileWorker = Effect.fn("makeScriptFileWorker")(
  function* (
    workerFactory: () => Worker = () =>
      new Worker(join(__dirname, "script-file-worker.js"), {
        resourceLimits: { maxOldGenerationSizeMb: SCRIPT_FILE_WORKER_HEAP_MB },
      }),
  ) {
    const run = yield* FiberSet.makeRuntime<never, void>();
    const acquire: Effect.Effect<
      RpcClient.FromGroup<typeof ScriptFileWorkerRpcs, RpcClientError>,
      never,
      Scope.Scope
    > = Effect.gen(function* () {
      let invalidate: Effect.Effect<void> = Effect.void;
      const protocol = yield* RpcClient.Protocol.make(
        Effect.fnUntraced(function* (writeResponse, clientIds) {
          const thread = yield* Effect.acquireRelease(
            Effect.sync(workerFactory),
            (worker) => Effect.promise(() => worker.terminate()),
          );
          thread.unref();
          const ready = yield* Deferred.make<void, RpcClientError>();
          let isReady = false;
          let failure: RpcClientError | undefined;
          const onMessage = (
            message: readonly [0] | readonly [1, FromServerEncoded],
          ) => {
            if (message[0] === 0) {
              isReady = true;
              Deferred.doneUnsafe(ready, Exit.void);
            } else {
              run(
                Effect.asVoid(
                  Effect.forEach(clientIds, (id) =>
                    writeResponse(id, message[1]),
                  ),
                ),
              );
            }
          };
          const onError = (cause: unknown) => {
            if (failure !== undefined) return;
            failure = new RpcClientError({
              reason: new WorkerReceiveError({
                message: "Script file worker failed.",
                cause,
              }),
            });
            Deferred.doneUnsafe(ready, Exit.fail(failure));
            const response = {
              _tag: "ClientProtocolError" as const,
              error: failure,
            };
            run(
              Effect.asVoid(
                Effect.forEach(clientIds, (id) => writeResponse(id, response)),
              ).pipe(Effect.andThen(invalidate)),
            );
          };
          const onExit = (code: number) =>
            onError(new Error(`Script file worker exited with code ${code}.`));
          yield* listen(thread, "message", onMessage);
          yield* listen(thread, "messageerror", onError);
          yield* listen(thread, "error", onError);
          yield* listen(thread, "exit", onExit);
          return {
            supportsAck: true,
            supportsTransferables: false,
            codecFor: Schema.toCodecJson,
            send: (_id, request) =>
              Effect.gen(function* () {
                // Startup must remain cancellable even before the worker's ready message.
                if (request._tag !== "Request" && !isReady) return;
                if (failure !== undefined) return yield* Effect.fail(failure);
                yield* Deferred.await(ready);
                yield* Effect.try({
                  try: () => thread.postMessage([0, request]),
                  catch: (cause) =>
                    new RpcClientError({
                      reason: new WorkerSendError({
                        message: "Could not send script file request.",
                        cause,
                      }),
                    }),
                });
              }),
          };
        }),
      );
      const client = yield* RpcClient.make(ScriptFileWorkerRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      invalidate = RcRef.invalidate(worker);
      return client;
    });
    const worker = yield* RcRef.make({
      acquire,
      idleTimeToLive: Duration.infinity,
    });
    const requests = yield* Semaphore.make(1);
    const slots = yield* Semaphore.make(SCRIPT_FILE_WORKER_QUEUE_LIMIT);

    return Effect.fn("ScriptFiles.processFile")(function* (path: string) {
      const result = yield* slots.withPermitsIfAvailable(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RcRef.get(worker);
            return yield* client.ResolveScriptFile({ path }).pipe(
              Effect.timeoutOrElse({
                duration: SCRIPT_FILE_WORKER_TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(
                    new ScriptFilesError({
                      path,
                      detail: `Script file processing timed out after ${SCRIPT_FILE_WORKER_TIMEOUT_MS} ms.`,
                    }),
                  ),
              }),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? RcRef.invalidate(worker) : Effect.void,
              ),
            );
          }),
        ).pipe(requests.withPermits(1)),
      );
      return yield* Option.match(result, {
        onNone: () =>
          Effect.fail(
            new ScriptFilesError({
              path,
              detail: "Script file worker queue is full.",
            }),
          ),
        onSome: Effect.succeed,
      });
    });
  },
);

const failureResolution = (
  path: string,
  failureCause: Cause.Cause<unknown>,
): ScriptFileAnalysisResolution => {
  const error = Cause.squash(failureCause);
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    status: "failed",
    path,
    message: normalized.message || "Script file processing failed.",
    failureCause,
    ...(normalized.stack === undefined
      ? {}
      : { detailsText: normalized.stack }),
  };
};

export const logScriptFileResolutionFailure = (
  path: string,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> => {
  if (cause.reasons.length === 0) return Effect.void;
  return (
    Cause.hasDies(cause)
      ? logFailure("Script file analysis failed unexpectedly", cause)
      : logFailure("Failed to resolve script file", cause, {
          failure: "warning",
        })
  ).pipe(
    Effect.annotateLogs({
      component: "script-files",
      data: { path },
      repeatKey: path,
    }),
  );
};

export const makeScriptFiles = (
  processFile: (path: string) => Promise<ScriptFileAnalysisResolution>,
): ScriptFilesShape => {
  const resolveFile = makeScriptFileResolver(processFile);

  const resolve: ScriptFilesShape["resolve"] = (path) =>
    Effect.promise(() => resolveFile(path)).pipe(
      Effect.tap((resolution) =>
        resolution.status === "failed" && resolution.failureCause !== undefined
          ? logScriptFileResolutionFailure(
              resolution.path,
              resolution.failureCause,
            )
          : Effect.void,
      ),
      Effect.map((resolution): ScriptFileResolution => {
        if (resolution.status === "found") {
          return { status: "found", file: resolution.analysis.file };
        }
        if (resolution.status === "missing") return resolution;
        const { failureCause: _, ...failed } = resolution;
        return failed;
      }),
    );

  const analyze: ScriptFilesShape["analyze"] = (path) =>
    Effect.promise(() => resolveFile(path)).pipe(
      Effect.flatMap((resolution) => {
        switch (resolution.status) {
          case "found":
            return Effect.succeed(resolution.analysis);
          case "missing":
            return Effect.fail(
              new ScriptFilesError({
                path: resolution.path,
                detail: `Script file was not found at ${resolution.path}.`,
              }),
            );
          case "failed":
            return Effect.fail(
              new ScriptFilesError({
                path: resolution.path,
                detail: resolution.message,
                ...(resolution.failureCause === undefined
                  ? {}
                  : { failureCause: resolution.failureCause }),
                ...(resolution.detailsText === undefined
                  ? {}
                  : { cause: new Error(resolution.detailsText) }),
              }),
            );
        }
      }),
    );

  const read: ScriptFilesShape["read"] = (path) =>
    analyze(path).pipe(Effect.map((analysis) => analysis.file));

  return ScriptFiles.of({ analyze, read, resolve });
};

export const makeScriptFileResolver = (
  processFile: (path: string) => Promise<ScriptFileAnalysisResolution>,
): ((path: string) => Promise<ScriptFileAnalysisResolution>) => {
  const inFlight = new Map<string, Promise<ScriptFileAnalysisResolution>>();

  return (path) => {
    const normalizedPath = resolvePath(path);
    const pending = inFlight.get(normalizedPath);
    if (pending !== undefined) return pending;

    const created = processFile(normalizedPath)
      .catch((error: unknown) =>
        failureResolution(
          normalizedPath,
          Cause.isCause(error) ? error : Cause.die(error),
        ),
      )
      .finally(() => {
        if (inFlight.get(normalizedPath) === created) {
          inFlight.delete(normalizedPath);
        }
      });
    inFlight.set(normalizedPath, created);
    return created;
  };
};

export const layer = Layer.effect(
  ScriptFiles,
  Effect.gen(function* () {
    const processFile = yield* makeScriptFileWorker();
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    return makeScriptFiles((path) =>
      runPromise(
        processFile(path).pipe(
          Effect.forkIn(scope),
          Effect.flatMap(Fiber.join),
          Effect.catchCause((cause) =>
            Effect.succeed(
              failureResolution(
                path,
                Cause.fromReasons(
                  cause.reasons.map((reason) =>
                    Cause.isFailReason(reason) && isRpcClientError(reason.error)
                      ? Cause.makeDieReason(reason.error)
                      : reason,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }),
);
