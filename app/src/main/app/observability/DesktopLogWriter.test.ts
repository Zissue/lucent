import { desktopLogErrorDetails } from "../../../shared/logRecord";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";

import { makeBufferedDesktopLogWriter } from "./DesktopLogWriter";

const fixtureDirectories = new Set<string>();
const at = "2026-10-12T12:34:56.789Z";
const backupName = "lucent.log.2026-10-12T12-34-56-789Z";

const makeFixture = async () => {
  const logsDir = await fs.mkdtemp(join(tmpdir(), "lucent-log-writer-"));
  fixtureDirectories.add(logsDir);
  const logFilePath = join(logsDir, "lucent.log");
  const writer = makeBufferedDesktopLogWriter(logsDir, logFilePath);
  return { logsDir, logFilePath, writer };
};

const makeSignal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const readRecords = async (path: string): Promise<unknown[]> =>
  (await fs.readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    [...fixtureDirectories].map((path) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
  fixtureDirectories.clear();
});

describe("DesktopLogWriter", () => {
  it("flushes pending records without closing the writer", async () => {
    const { logFilePath, writer } = await makeFixture();
    writer.write({ sequence: "first" });
    await writer.flush();
    expect(await readRecords(logFilePath)).toEqual([{ sequence: "first" }]);
    writer.write({ sequence: "second" });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      { sequence: "first" },
      { sequence: "second" },
    ]);
  });

  it("evicts the oldest debug record for an incoming error", async () => {
    const { logFilePath, writer } = await makeFixture();
    for (let sequence = 0; sequence < 256; sequence += 1) {
      writer.write({ level: "debug", sequence });
    }
    writer.write({ level: "error", sequence: "incoming" });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { dropped: { debug: 1 } },
      },
      ...Array.from({ length: 255 }, (_, index) => ({
        level: "debug",
        sequence: index + 1,
      })),
      { level: "error", sequence: "incoming" },
    ]);
  });

  it("drops incoming debug when the queue contains only errors", async () => {
    const { logFilePath, writer } = await makeFixture();
    for (let sequence = 0; sequence < 256; sequence += 1) {
      writer.write({ level: "error", sequence });
    }
    writer.write({ level: "debug", sequence: "incoming" });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { dropped: { debug: 1 } },
      },
      ...Array.from({ length: 256 }, (_, sequence) => ({
        level: "error",
        sequence,
      })),
    ]);
  });

  it("evicts lowest severity first and normalizes unknown levels to info", async () => {
    const { logFilePath, writer } = await makeFixture();
    const initial = [
      { level: "warn", sequence: "warn" },
      { level: "debug", sequence: "debug" },
      { level: "trace", sequence: "trace" },
      { level: "unknown", sequence: "unknown" },
      { sequence: "missing" },
      { level: "error", sequence: "error" },
    ];
    for (const record of initial) writer.write(record);
    for (let sequence = 0; sequence < 250; sequence += 1) {
      writer.write({ level: "fatal", sequence });
    }
    for (let sequence = 0; sequence < 7; sequence += 1) {
      writer.write({ level: "fatal", sequence: `new-${sequence}` });
    }
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: {
          dropped: { trace: 1, debug: 1, info: 2, warn: 1, error: 1, fatal: 1 },
        },
      },
      ...Array.from({ length: 250 }, (_, sequence) => ({
        level: "fatal",
        sequence,
      })),
      ...Array.from({ length: 6 }, (_, sequence) => ({
        level: "fatal",
        sequence: `new-${sequence}`,
      })),
    ]);
  });

  it("keeps the final record beyond the pending queue limit", async () => {
    const { logFilePath, writer } = await makeFixture();
    for (let sequence = 0; sequence < 300; sequence += 1)
      writer.write({ sequence });
    await writer.close({ sequence: "final" });
    writer.write({ sequence: "after close" });
    await writer.close({ sequence: "second close" });
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { dropped: { info: 44 } },
      },
      ...Array.from({ length: 256 }, (_, sequence) => ({ sequence })),
      { sequence: "final" },
    ]);
  });

  it("replaces a 20 KiB record with original metadata and a short message", async () => {
    const { logFilePath, writer } = await makeFixture();
    writer.write({
      at,
      level: "error",
      component: "test",
      message: "x".repeat(20 * 1024),
    });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "error",
        component: "test",
        message: "x".repeat(1024),
        truncated: { bytes: 20561 },
      },
    ]);
  });

  it("counts serialized UTF-8 bytes and preserves the exact size boundary", async () => {
    const { logFilePath, writer } = await makeFixture();
    writer.write({ message: "x".repeat(16370) });
    writer.write({ message: "é".repeat(8192) });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      { message: "x".repeat(16370) },
      { message: "é".repeat(1024), truncated: { bytes: 16398 } },
    ]);
  });

  it("serializes at flush and supports bigint, circular values, and errors", async () => {
    const { logFilePath, writer } = await makeFixture();
    const cause = new Error("broken");
    cause.stack = "Error: broken\n    at test";
    const record = { message: "before", bigint: 42n, cause, self: {} };
    record.self = record;
    writer.write(record);
    record.message = "after";
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        message: "after",
        bigint: "42",
        cause: {
          name: "Error",
          message: "broken",
          stack: "Error: broken\n    at test",
        },
        self: "[Circular]",
      },
    ]);
    expect(desktopLogErrorDetails("plain cause")).toEqual({
      name: "NonError",
      message: "plain cause",
    });
  });

  it("reports a failed append at the start of the next successful batch", async () => {
    const { logFilePath, writer } = await makeFixture();
    vi.spyOn(fs, "appendFile").mockRejectedValueOnce(
      new Error("append failed"),
    );
    writer.write({ level: "error", sequence: "lost" });
    await writer.flush();
    writer.write({ sequence: "kept" });
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { failedWrites: 1, failedRecords: { error: 1 } },
      },
      { sequence: "kept" },
    ]);
  });

  it("retains detached losses and new drops across repeated append failures", async () => {
    const { logFilePath, writer } = await makeFixture();
    const entered = makeSignal();
    const release = makeSignal();
    vi.spyOn(fs, "appendFile")
      .mockRejectedValueOnce(new Error("first failure"))
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("second failure");
      });
    for (let index = 0; index < 257; index += 1)
      writer.write({ level: "debug" });
    await writer.flush();
    writer.write({ level: "error" });
    const flushing = writer.flush();
    await entered.promise;
    for (let index = 0; index < 257; index += 1)
      writer.write({ level: "fatal" });
    release.resolve();
    await flushing;
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: {
          dropped: { debug: 1, fatal: 1 },
          failedWrites: 2,
          failedRecords: { debug: 256, error: 1 },
        },
      },
      ...Array.from({ length: 256 }, () => ({ level: "fatal" })),
    ]);
  });

  it("rechecks file size after a partially written failed append", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    writer.write({ sequence: "first" });
    await writer.flush();
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => {
      await fs.truncate(logFilePath, 10 * 1024 * 1024);
      throw new Error("partial append");
    });
    writer.write({ level: "warn", sequence: "lost" });
    await writer.flush();
    writer.write({ sequence: "next" });
    await writer.close();
    expect((await fs.stat(join(logsDir, backupName))).size).toBe(10485760);
    expect(await readRecords(logFilePath)).toEqual([
      {
        at,
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { failedWrites: 1, failedRecords: { warn: 1 } },
      },
      { sequence: "next" },
    ]);
  });

  it("terminates failed flushes and retries a loss-only notice only on request", async () => {
    const { logFilePath, writer } = await makeFixture();
    const append = vi
      .spyOn(fs, "appendFile")
      .mockRejectedValue(new Error("unavailable"));
    writer.write({ level: "warn" });
    await writer.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await writer.flush();
    append.mockRestore();
    await writer.close();
    expect(await readRecords(logFilePath)).toEqual([
      {
        at: "2026-10-12T12:34:57.789Z",
        level: "warn",
        component: "observability",
        message: "Log records lost",
        event: "records.lost",
        data: { failedWrites: 2, failedRecords: { warn: 1 } },
      },
    ]);
  });

  it("flushes on the 250 ms timer and drains writes arriving during append", async () => {
    const { logFilePath, writer } = await makeFixture();
    const entered = makeSignal();
    const release = makeSignal();
    const append = fs.appendFile.bind(fs);
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await append(...args);
    });
    writer.write({ sequence: "first" });
    await vi.advanceTimersByTimeAsync(250);
    await entered.promise;
    writer.write({ sequence: "second" });
    const closing = writer.close({ sequence: "final" });
    release.resolve();
    await closing;
    expect(await readRecords(logFilePath)).toEqual([
      { sequence: "first" },
      { sequence: "second" },
      { sequence: "final" },
    ]);
  });

  it("rotates a full file to a timestamped backup before appending", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    await fs.writeFile(logFilePath, "");
    await fs.truncate(logFilePath, 10 * 1024 * 1024);
    await writer.close({ sequence: "new" });
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      backupName,
    ]);
    expect((await fs.stat(join(logsDir, backupName))).size).toBe(10485760);
    expect(await readRecords(logFilePath)).toEqual([{ sequence: "new" }]);
  });

  it("retains the newest three timestamped backups", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    await writer.close();
    for (let sequence = 0; sequence < 5; sequence += 1) {
      vi.setSystemTime(new Date(`2026-10-12T12:00:0${sequence}.000Z`));
      await fs.writeFile(logFilePath, "");
      await fs.truncate(logFilePath, 10 * 1024 * 1024);
      const nextWriter = makeBufferedDesktopLogWriter(logsDir, logFilePath);
      await nextWriter.close({ sequence });
    }
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      "lucent.log.2026-10-12T12-00-02-000Z",
      "lucent.log.2026-10-12T12-00-03-000Z",
      "lucent.log.2026-10-12T12-00-04-000Z",
    ]);
    expect(await readRecords(logFilePath)).toEqual([{ sequence: 4 }]);
  });

  it("appends after rename failure without deleting backups and retries next batch", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    await fs.writeFile(logFilePath, "");
    await fs.truncate(logFilePath, 10 * 1024 * 1024);
    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(`${logFilePath}.${index}`, `legacy-${index}`);
    }
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    writer.write({ sequence: "first" });
    await writer.flush();
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      "lucent.log.1",
      "lucent.log.2",
      "lucent.log.3",
      "lucent.log.4",
    ]);
    expect((await fs.readFile(logFilePath, "utf8")).slice(10485760)).toBe(
      '{"sequence":"first"}\n',
    );
    writer.write({ sequence: "second" });
    await writer.close();
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      backupName,
    ]);
    expect(await readRecords(logFilePath)).toEqual([{ sequence: "second" }]);
    expect(
      (await fs.readFile(join(logsDir, backupName), "utf8")).slice(10485760),
    ).toBe('{"sequence":"first"}\n');
  });

  it("prunes legacy and old timestamp backups on startup without touching unrelated files", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    const names = [
      "1",
      "2",
      "3",
      "4",
      "0005",
      "2026-10-10T00-00-00-000Z",
      "2026-10-11T00-00-00-000Z",
      "2026-10-12T00-00-00-000Z",
      "2026-10-13T00-00-00-000Z",
      "notes",
    ];
    await Promise.all(
      names.map((name) => fs.writeFile(`${logFilePath}.${name}`, name)),
    );
    await writer.close({ sequence: "new" });
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      "lucent.log.2026-10-11T00-00-00-000Z",
      "lucent.log.2026-10-12T00-00-00-000Z",
      "lucent.log.2026-10-13T00-00-00-000Z",
      "lucent.log.notes",
    ]);
    expect(await readRecords(logFilePath)).toEqual([{ sequence: "new" }]);
  });

  it("ignores backup deletion errors while appending the batch", async () => {
    const { logsDir, logFilePath, writer } = await makeFixture();
    await fs.writeFile(`${logFilePath}.1`, "legacy");
    vi.spyOn(fs, "unlink").mockRejectedValue(new Error("delete failed"));
    await writer.close({ sequence: "new" });
    expect((await fs.readdir(logsDir)).toSorted()).toEqual([
      "lucent.log",
      "lucent.log.1",
    ]);
    expect(await readRecords(logFilePath)).toEqual([{ sequence: "new" }]);
  });
});
