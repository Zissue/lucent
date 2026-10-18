import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { processScriptFile } from "./ScriptFileAnalysis";
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

it("retries one detected change and analyzes the new source", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
  directories.push(root);
  const path = join(root, "value.js");
  await fs.writeFile(path, "exports.value = 1;");
  const stat = fs.stat;
  let checks = 0;
  vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    checks += 1;
    if (checks === 2) await fs.writeFile(path, "exports.value = 22;");
    return stat(...args);
  });

  expect(await processScriptFile(path)).toMatchObject({
    status: "found",
    analysis: {
      file: { source: "exports.value = 22;", name: "value.js", inputs: null },
      requirements: [],
    },
  });
  expect(checks).toBe(4);
});

it("reports a changed file after two attempts", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
  directories.push(root);
  const path = join(root, "value.js");
  await fs.writeFile(path, "exports.value = 1;");
  const stat = fs.stat;
  let checks = 0;
  vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    checks += 1;
    if (checks % 2 === 0) await fs.appendFile(path, " ");
    return stat(...args);
  });

  const result = await processScriptFile(path);
  expect(result).toMatchObject({
    status: "failed",
    path,
    message: `Script file changed while it was being read: ${path}.`,
  });
  expect(result).not.toHaveProperty("failureCause");
  expect(await fs.readFile(path, "utf8")).toBe("exports.value = 1;  ");
  expect(checks).toBe(4);
});

it("does not retry permission failures", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
  directories.push(root);
  const path = join(root, "value.js");
  await fs.writeFile(path, "exports.value = 1;");
  let checks = 0;
  vi.spyOn(fs, "stat").mockImplementation(async () => {
    checks += 1;
    throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
  });

  expect(await processScriptFile(path)).toMatchObject({
    status: "failed",
    path,
    message: "Permission denied",
  });
  expect(checks).toBe(1);
});

it("keeps read failures in the failure channel of the reported cause", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
  directories.push(root);
  const path = join(root, "unreadable.js");
  vi.spyOn(fs, "stat").mockRejectedValue(new Error("Read failed"));

  const result = await processScriptFile(path);
  expect(result).toMatchObject({
    status: "failed",
    path,
    message: "Read failed",
  });
  if (result.status !== "failed" || result.failureCause === undefined)
    throw new Error("Missing read failure cause");
  expect(Cause.hasDies(result.failureCause)).toBe(false);
  expect(Cause.squash(result.failureCause)).toEqual(new Error("Read failed"));
});

it("reports source validation failures without an unexpected failure cause", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
  directories.push(root);
  const path = join(root, "invalid.js");
  await fs.writeFile(path, "module.exports = function* (");

  const result = await processScriptFile(path);
  expect(result).toMatchObject({
    status: "failed",
    path,
    message: "Script source could not be parsed.",
  });
  expect(result).not.toHaveProperty("failureCause");
});

it.each(["defect", "interrupt"] as const)(
  "retains an analyzer %s in the reported cause",
  async (kind) => {
    const root = await fs.mkdtemp(join(tmpdir(), "lucent-analysis-"));
    directories.push(root);
    const path = join(root, "value.js");
    await fs.writeFile(path, "exports.value = 1;");
    vi.spyOn(ScriptSourceParser, "analyzeScriptSource").mockReturnValue(
      kind === "defect"
        ? Effect.die(new Error("Analyzer defect"))
        : Effect.interrupt,
    );

    const result = await processScriptFile(path);
    expect(result.status).toBe("failed");
    if (result.status !== "failed" || result.failureCause === undefined)
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
  },
);
