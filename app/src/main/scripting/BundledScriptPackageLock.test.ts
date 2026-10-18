import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { desktopLogErrorDetails } from "../../shared/logRecord";
import { acquireBundledScriptPackageLock } from "./BundledScriptPackageLock";

const directories = new Set<string>();

const makeFixture = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "lucent-package-lock-"));
  directories.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...directories].map((path) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
  directories.clear();
});

describe("BundledScriptPackageLock", () => {
  it("keeps corrupt owner contents out of logged parse failures", async () => {
    const root = await makeFixture();
    const path = join(root, "lock");
    await fs.mkdir(path);
    await fs.writeFile(
      join(path, "owner.json"),
      '{"token": hunter2-secret-token}',
    );

    const failure: unknown = await acquireBundledScriptPackageLock(path).catch(
      (cause: unknown) => cause,
    );
    const logged = desktopLogErrorDetails(failure);

    expect(JSON.stringify(logged)).not.toContain("hunter2");
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(logged).toMatchObject({
      name: "SyntaxError",
      message: "Invalid JSON",
    });
    expect(logged.cause).toBeUndefined();
    expect(await fs.readdir(root)).toEqual(["lock"]);
  });

  it("claims an absent lock, keeps its live owner, and releases it", async () => {
    const root = await makeFixture();
    const path = join(root, "lock");
    const release = await acquireBundledScriptPackageLock(path);
    expect(typeof release).toBe("function");
    if (release === undefined) throw new Error("Lock was not acquired");

    try {
      expect(await fs.readdir(path)).toEqual(["owner.json"]);
      expect(await acquireBundledScriptPackageLock(path)).toBeUndefined();
    } finally {
      await release();
    }

    expect(await fs.readdir(root)).toEqual([]);
  });
});
