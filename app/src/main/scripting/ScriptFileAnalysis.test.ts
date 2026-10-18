import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { analyzeScriptFile, ScriptFilesError } from "./ScriptFileAnalysis";
import * as ScriptSourceParser from "./ScriptSourceParser";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

it.effect("retries one detected change and analyzes the new source", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
    );
    directories.push(root);
    const path = join(root, "value.js");
    yield* Effect.promise(() => fs.writeFile(path, "exports.value = 1;"));
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      if (checks === 2) await fs.writeFile(path, "exports.value = 22;");
      return stat(...args);
    });

    expect(yield* analyzeScriptFile(path)).toMatchObject({
      file: { source: "exports.value = 22;", name: "value.js", inputs: null },
      requirements: [],
    });
    expect(checks).toBe(4);
  }),
);

it.effect("reports a changed file after two attempts", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
    );
    directories.push(root);
    const path = join(root, "value.js");
    yield* Effect.promise(() => fs.writeFile(path, "exports.value = 1;"));
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      if (checks % 2 === 0) await fs.appendFile(path, " ");
      return stat(...args);
    });

    const result = yield* analyzeScriptFile(path).pipe(Effect.flip);
    expect(result).toMatchObject({
      _tag: "ScriptFilesError",
      path,
      message: `Script file changed while it was being read: ${path}.`,
    });
    expect(result).not.toHaveProperty("failureCause");
    expect(yield* Effect.promise(() => fs.readFile(path, "utf8"))).toBe(
      "exports.value = 1;  ",
    );
    expect(checks).toBe(4);
  }),
);

it.effect("retries when the file disappears after reading", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
    );
    directories.push(root);
    const path = join(root, "value.js");
    yield* Effect.promise(() => fs.writeFile(path, "exports.value = 1;"));
    const stat = fs.stat;
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      checks += 1;
      if (checks === 2) {
        throw Object.assign(new Error("File disappeared"), { code: "ENOENT" });
      }
      return stat(...args);
    });

    expect(yield* analyzeScriptFile(path)).toMatchObject({
      file: { source: "exports.value = 1;", path },
    });
    expect(checks).toBe(4);
  }),
);

it.effect("does not retry permission failures", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
    );
    directories.push(root);
    const path = join(root, "value.js");
    yield* Effect.promise(() => fs.writeFile(path, "exports.value = 1;"));
    let checks = 0;
    vi.spyOn(fs, "stat").mockImplementation(async () => {
      checks += 1;
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    });

    expect(yield* analyzeScriptFile(path).pipe(Effect.flip)).toMatchObject({
      _tag: "ScriptFilesError",
      path,
      message: "Permission denied",
    });
    expect(checks).toBe(1);
  }),
);

it.effect(
  "keeps read failures in the failure channel of the reported cause",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
      );
      directories.push(root);
      const path = join(root, "unreadable.js");
      vi.spyOn(fs, "stat").mockRejectedValue(new Error("Read failed"));

      const result = yield* analyzeScriptFile(path).pipe(Effect.flip);
      expect(result).toMatchObject({
        _tag: "ScriptFilesError",
        path,
        message: "Read failed",
      });
      if (result.failureCause === undefined)
        throw new Error("Missing read failure cause");
      expect(Cause.hasDies(result.failureCause)).toBe(false);
      expect(Cause.squash(result.failureCause)).toEqual(
        new Error("Read failed"),
      );
    }),
);

it.effect(
  "reports source validation failures without an unexpected failure cause",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
      );
      directories.push(root);
      const path = join(root, "invalid.js");
      yield* Effect.promise(() =>
        fs.writeFile(path, "module.exports = function* ("),
      );

      const result = yield* analyzeScriptFile(path).pipe(Effect.flip);
      expect(result).toMatchObject({
        _tag: "ScriptFilesError",
        path,
        message: "Script source could not be parsed.",
      });
      expect(result).not.toHaveProperty("failureCause");
    }),
);

it.effect.each(["defect", "interrupt"] as const)(
  "retains an analyzer %s in the reported cause",
  (kind) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        fs.mkdtemp(join(tmpdir(), "lucent-analysis-")),
      );
      directories.push(root);
      const path = join(root, "value.js");
      yield* Effect.promise(() => fs.writeFile(path, "exports.value = 1;"));
      vi.spyOn(ScriptSourceParser, "analyzeScriptSource").mockReturnValue(
        kind === "defect"
          ? Effect.die(new Error("Analyzer defect"))
          : Effect.interrupt,
      );

      const result = yield* analyzeScriptFile(path).pipe(Effect.flip);
      expect(result).toBeInstanceOf(ScriptFilesError);
      if (result.failureCause === undefined)
        throw new Error("Missing analyzer failure cause");
      expect(Cause.hasDies(result.failureCause)).toBe(kind === "defect");
      expect(Cause.hasInterruptsOnly(result.failureCause)).toBe(
        kind === "interrupt",
      );
      if (kind === "defect") {
        expect(result.message).toBe("Analyzer defect");
        expect(Cause.squash(result.failureCause)).toEqual(
          new Error("Analyzer defect"),
        );
      }
    }),
);
