import { mkdtemp, rm, stat, truncate, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@effect/vitest";

import { makeScriptFileResolver, makeScriptFileWorker } from "./ScriptFiles";
import { processScriptFile } from "./ScriptFileAnalysis";
import type { ScriptFileAnalysisResolution } from "./ScriptFileWorkerProtocol";
import { SCRIPT_FILE_MAX_BYTES } from "./ScriptLimits";

const tempDirectories = new Set<string>();

let workerDirectory: string;
let workerPath: string;
beforeAll(async () => {
  workerDirectory = await mkdtemp(join(tmpdir(), "lucent-script-worker-"));
  workerPath = join(workerDirectory, "worker.cjs");
  await build({
    entryPoints: [join(import.meta.dirname, "ScriptFileWorker.ts")],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    logLevel: "silent",
  });
});
afterAll(async () => {
  await rm(workerDirectory, { recursive: true, force: true });
});

const makeTempDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "lucent-script-files-"));
  tempDirectories.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
  tempDirectories.clear();
});

describe("script file processing", () => {
  it("returns the current source and extracted inputs after a same-size edit", async () => {
    const directory = await makeTempDirectory();
    const path = join(directory, "farm.js");
    const firstSource = [
      'const helper = require("./helper");',
      "module.exports = function* run() { return 1; };",
      "module.exports.inputs = { fields: [] };",
    ].join("\n");
    const secondSource = firstSource.replace("return 1", "return 2");
    expect(secondSource).toHaveLength(firstSource.length);

    await writeFile(path, firstSource);
    const firstStat = await stat(path);
    const first = await processScriptFile(path);

    await writeFile(path, secondSource);
    await utimes(path, firstStat.atime, firstStat.mtime);
    const second = await processScriptFile(path);

    expect(first.status).toBe("found");
    expect(second.status).toBe("found");
    if (first.status === "found" && second.status === "found") {
      expect(first.analysis.file.source).toBe(firstSource);
      expect(second.analysis.file.source).toBe(secondSource);
      expect(second.analysis.file.revision).not.toBe(
        first.analysis.file.revision,
      );
      expect(second.analysis.file.inputs).toEqual({ id: path, fields: [] });
      expect(second.analysis.requirements).toEqual(["./helper"]);
    }
  });

  it("does not cache missing files", async () => {
    const directory = await makeTempDirectory();
    const path = join(directory, "created-later.js");

    await expect(processScriptFile(path)).resolves.toEqual({
      status: "missing",
      path,
    });

    await writeFile(path, "module.exports = function* run() {};");
    const resolution = await processScriptFile(path);
    expect(resolution.status).toBe("found");
  });

  it("returns processing failures for malformed and oversized scripts", async () => {
    const directory = await makeTempDirectory();
    const malformedPath = join(directory, "malformed.js");
    const oversizedPath = join(directory, "oversized.js");
    await writeFile(malformedPath, "module.exports = function* (");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, SCRIPT_FILE_MAX_BYTES + 1);

    const malformed = await processScriptFile(malformedPath);
    const oversized = await processScriptFile(oversizedPath);

    expect(malformed).toMatchObject({
      status: "failed",
      path: malformedPath,
      message: expect.stringContaining("parsed"),
    });
    expect(oversized).toMatchObject({
      status: "failed",
      path: oversizedPath,
      message: expect.stringContaining("16 MiB"),
    });
  });
});

describe("ScriptFiles service", () => {
  it.effect("decodes script analysis from the bundled RPC worker", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const path = join(directory, "rpc.js");
      yield* Effect.promise(() =>
        writeFile(path, "module.exports = function* run() {};"),
      );
      const resolve = yield* makeScriptFileWorker(() => new Worker(workerPath));
      expect(yield* resolve(path)).toMatchObject({
        status: "found",
        analysis: {
          file: { path, name: "rpc.js", inputs: null },
          requirements: [],
        },
      });
    }),
  );

  it.effect(
    "continues queued requests with a fresh RPC worker after a crash",
    () =>
      Effect.gen(function* () {
        const workers: Worker[] = [];
        const resolve = yield* makeScriptFileWorker(() => {
          const worker =
            workers.length === 0
              ? new Worker("throw new Error('worker crashed')", { eval: true })
              : new Worker(workerPath);
          workers.push(worker);
          expect(workers.filter((entry) => entry.threadId !== -1)).toHaveLength(
            1,
          );
          return worker;
        });
        const first = yield* resolve("/scripts/crash.js").pipe(
          Effect.result,
          Effect.forkScoped,
        );
        const second = yield* resolve("/scripts/missing.js").pipe(
          Effect.forkScoped,
        );
        expect(Result.isFailure(yield* Fiber.join(first))).toBe(true);
        expect(yield* Fiber.join(second)).toEqual({
          status: "missing",
          path: "/scripts/missing.js",
        });
        expect(workers).toHaveLength(2);
      }),
  );

  it.effect(
    "terminates a CPU-bound worker at the deadline and services the next request",
    () =>
      Effect.gen(function* () {
        const ready = new Int32Array(new SharedArrayBuffer(4));
        const workers: Worker[] = [];
        const resolve = yield* makeScriptFileWorker(() => {
          const worker =
            workers.length === 0
              ? new Worker(
                  "const { workerData } = require('node:worker_threads'); Atomics.store(new Int32Array(workerData), 0, 1); while (true) {}",
                  { eval: true, workerData: ready.buffer },
                )
              : new Worker(workerPath);
          workers.push(worker);
          return worker;
        });
        const first = yield* resolve("/scripts/slow.js").pipe(
          Effect.flip,
          Effect.forkScoped,
        );
        const second = yield* resolve("/scripts/missing.js").pipe(
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(Atomics.load(ready, 0)).toBe(1)),
        );
        yield* TestClock.adjust(10_000);
        expect((yield* Fiber.join(first)).message).toContain(
          "timed out after 10000 ms",
        );
        expect(yield* Fiber.join(second)).toEqual({
          status: "missing",
          path: "/scripts/missing.js",
        });
        expect(workers).toHaveLength(2);
        expect(workers[0]!.threadId).toBe(-1);
      }),
  );

  it.effect(
    "rejects overload without growing the worker pool and cancels its active worker",
    () =>
      Effect.gen(function* () {
        const workers: Worker[] = [];
        const resolve = yield* makeScriptFileWorker(() => {
          const worker = new Worker("while (true) {}", { eval: true });
          workers.push(worker);
          return worker;
        });
        const pending = yield* Effect.forEach(
          Array.from({ length: 64 }, (_, i) => `/scripts/${i}.js`),
          (path) => resolve(path).pipe(Effect.forkScoped),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(workers).toHaveLength(1)),
        );
        expect(
          (yield* resolve("/scripts/overflow.js").pipe(Effect.flip)).message,
        ).toBe("Script file worker queue is full.");
        yield* Fiber.interruptAll(pending);
        expect(workers).toHaveLength(1);
        expect(workers[0]!.threadId).toBe(-1);
      }),
  );

  it("coalesces concurrent requests for the same normalized path", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processFile = async (
      path: string,
    ): Promise<ScriptFileAnalysisResolution> => {
      calls += 1;
      await gate;
      return {
        status: "found",
        analysis: {
          file: {
            inputs: null,
            name: "farm.js",
            path,
            revision: "abc123",
            source: "module.exports = function* run() {};",
          },
          fingerprint: "fingerprint",
          requirements: [],
        },
      };
    };
    const resolveFile = makeScriptFileResolver(processFile);

    const first = resolveFile("./scripts/farm.js");
    const second = resolveFile("scripts/farm.js");
    await Promise.resolve();

    expect(calls).toBe(1);
    release?.();
    const [firstResolution, secondResolution] = await Promise.all([
      first,
      second,
    ]);
    expect(firstResolution).toEqual(secondResolution);
    expect(firstResolution).toMatchObject({
      status: "found",
      analysis: { file: { path: resolvePath("scripts/farm.js") } },
    });
  });
});

it.effect("replaces an idle worker before accepting the next request", () =>
  Effect.gen(function* () {
    const workers: Worker[] = [];
    const resolve = yield* makeScriptFileWorker(() => {
      const worker = new Worker(workerPath);
      workers.push(worker);
      return worker;
    });
    const directory = yield* Effect.promise(makeTempDirectory);
    const path = join(directory, "valid.js");
    yield* Effect.promise(() =>
      writeFile(path, "module.exports = function* run() {};"),
    );
    expect((yield* resolve(path)).status).toBe("found");
    yield* Effect.promise(() => workers[0]!.terminate());
    expect(workers[0]!.threadId).toBe(-1);
    const second = yield* resolve(path).pipe(Effect.result);
    expect(second).toMatchObject({
      _tag: "Success",
      success: { status: "found" },
    });
    expect(workers).toHaveLength(2);
  }),
);
