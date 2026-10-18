import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vitest";

import { processScriptFile } from "./ScriptFileAnalysis";

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
