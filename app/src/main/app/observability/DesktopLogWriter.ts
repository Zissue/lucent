import { promises as fs } from "fs";
import { basename, join } from "path";

const FLUSH_INTERVAL_MS = 250;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_PENDING_RECORDS = 256;
const MAX_RECORD_BYTES = 16 * 1024;
const ROTATION_COUNT = 3;
const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
const TIMESTAMP_BACKUP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

type LogLevel = (typeof LOG_LEVELS)[number];
type LevelCounts = Partial<Record<LogLevel, number>>;
type PendingRecord = { record: unknown; level: LogLevel };

const addCounts = (target: LevelCounts, source: LevelCounts): void => {
  for (const level of LOG_LEVELS) {
    if (source[level] !== undefined) {
      target[level] = (target[level] ?? 0) + source[level];
    }
  }
};

const recordLevel = (record: unknown): LogLevel => {
  try {
    const value =
      typeof record === "object" && record !== null && "level" in record
        ? record.level
        : undefined;
    return LOG_LEVELS.find((level) => level === value) ?? "info";
  } catch {
    return "info";
  }
};

export interface DesktopLogError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: DesktopLogError;
}

export const desktopLogErrorDetails = (
  value: unknown,
  depth = 0,
): DesktopLogError => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined || depth >= 5
        ? {}
        : { cause: desktopLogErrorDetails(value.cause, depth + 1) }),
    };
  }

  let message: string;
  try {
    message =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    try {
      message = String(value);
    } catch {
      message = "[Unserializable]";
    }
  }
  return { name: "NonError", message: message.slice(0, 1_024) };
};

const fallbackSerializationRecord = () => ({
  at: new Date().toISOString(),
  level: "error",
  component: "observability",
  message: "Failed to serialize log record",
});

const serializeDiagnostic = (record: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    const source = JSON.stringify(record, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return desktopLogErrorDetails(value);
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
    if (source === undefined) {
      return `${JSON.stringify(fallbackSerializationRecord())}\n`;
    }

    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes <= MAX_RECORD_BYTES) {
      return `${source}\n`;
    }

    const serialized: unknown = JSON.parse(source);
    const metadata =
      typeof serialized === "object" && serialized !== null ? serialized : {};
    const message = "message" in metadata ? metadata.message : undefined;
    return `${JSON.stringify({
      at: "at" in metadata ? metadata.at : undefined,
      level: "level" in metadata ? metadata.level : undefined,
      component: "component" in metadata ? metadata.component : undefined,
      message: typeof message === "string" ? message.slice(0, 1024) : undefined,
      truncated: { bytes },
    })}\n`;
  } catch {
    return `${JSON.stringify(fallbackSerializationRecord())}\n`;
  }
};

const isMissingFileError = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export interface DesktopLogWriter {
  readonly close: (finalRecord?: unknown) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly write: (record: unknown) => boolean;
}

export const makeBufferedDesktopLogWriter = (
  logsDir: string,
  logFilePath: string,
): DesktopLogWriter => {
  const backupPrefix = `${basename(logFilePath)}.`;
  let closed = false;
  let dropped: LevelCounts = {};
  let failedWrites = 0;
  let failedRecords: LevelCounts = {};
  let fileBytes: number | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let pending: PendingRecord[] = [];
  let startupPruned = false;
  let writeInFlight: Promise<void> | undefined;

  const pruneBackups = async (): Promise<void> => {
    try {
      const names = (await fs.readdir(logsDir)).filter((name) =>
        name.startsWith(backupPrefix),
      );
      const timestamps = names
        .filter((name) =>
          TIMESTAMP_BACKUP.test(name.slice(backupPrefix.length)),
        )
        .toSorted();
      const obsolete = timestamps.slice(
        0,
        Math.max(0, timestamps.length - ROTATION_COUNT),
      );
      if (!startupPruned) {
        obsolete.push(
          ...names.filter((name) =>
            /^\d+$/.test(name.slice(backupPrefix.length)),
          ),
        );
      }
      await Promise.all(
        obsolete.map((name) =>
          fs.unlink(join(logsDir, name)).catch(() => undefined),
        ),
      );
    } catch {}
    startupPruned = true;
  };

  const rotate = async (): Promise<void> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(logFilePath, join(logsDir, `${backupPrefix}${stamp}`));
    fileBytes = 0;
  };

  const append = async (source: string, bytes: number): Promise<void> => {
    await fs.mkdir(logsDir, { recursive: true });
    if (fileBytes === undefined) {
      try {
        fileBytes = (await fs.stat(logFilePath)).size;
      } catch (cause) {
        if (!isMissingFileError(cause)) {
          throw cause;
        }
        fileBytes = 0;
      }
    }
    if (fileBytes > 0 && fileBytes + bytes > MAX_LOG_BYTES) {
      await rotate().then(pruneBackups, () => undefined);
    } else if (!startupPruned) {
      await pruneBackups();
    }
    await fs.appendFile(logFilePath, source, "utf8");
    fileBytes += bytes;
  };

  const flushBatch = (): Promise<void> => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (writeInFlight !== undefined) {
      return writeInFlight;
    }
    if (
      pending.length === 0 &&
      Object.keys(dropped).length === 0 &&
      failedWrites === 0
    ) {
      return Promise.resolve();
    }

    const records = pending;
    const batchDropped = dropped;
    const batchFailedWrites = failedWrites;
    const batchFailedRecords = failedRecords;
    pending = [];
    dropped = {};
    failedWrites = 0;
    failedRecords = {};

    const serializedRecords: string[] = [];
    if (Object.keys(batchDropped).length > 0 || batchFailedWrites > 0) {
      serializedRecords.push(
        serializeDiagnostic({
          at: new Date().toISOString(),
          level: "warn",
          component: "observability",
          message: "Log records lost",
          event: "records.lost",
          data: {
            ...(Object.keys(batchDropped).length > 0
              ? { dropped: batchDropped }
              : {}),
            ...(batchFailedWrites > 0
              ? { failedWrites: batchFailedWrites }
              : {}),
            ...(Object.keys(batchFailedRecords).length > 0
              ? { failedRecords: batchFailedRecords }
              : {}),
          },
        }),
      );
    }
    for (const { record } of records) {
      serializedRecords.push(serializeDiagnostic(record));
    }
    const source = serializedRecords.join("");
    writeInFlight = append(source, Buffer.byteLength(source, "utf8"))
      .catch(() => {
        fileBytes = undefined;
        failedWrites += batchFailedWrites + 1;
        addCounts(dropped, batchDropped);
        addCounts(failedRecords, batchFailedRecords);
        for (const { level } of records) {
          addCounts(failedRecords, { [level]: 1 });
        }
      })
      .finally(() => {
        writeInFlight = undefined;
        if (!closed && pending.length > 0) {
          scheduleFlush(0);
        }
      });
    return writeInFlight;
  };

  const scheduleFlush = (delayMs = FLUSH_INTERVAL_MS): void => {
    if (flushTimer !== undefined && delayMs !== 0) {
      return;
    }
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushBatch();
    }, delayMs);
    flushTimer.unref?.();
  };

  const write = (record: unknown): boolean => {
    if (closed) {
      return false;
    }
    const level = recordLevel(record);
    if (pending.length >= MAX_PENDING_RECORDS) {
      let lowestLevel = level;
      let evictionIndex = -1;
      pending.forEach((entry, index) => {
        if (LOG_LEVELS.indexOf(entry.level) < LOG_LEVELS.indexOf(lowestLevel)) {
          lowestLevel = entry.level;
          evictionIndex = index;
        }
      });
      dropped[lowestLevel] = (dropped[lowestLevel] ?? 0) + 1;
      if (evictionIndex === -1) {
        scheduleFlush(0);
        return false;
      }
      pending.splice(evictionIndex, 1);
    }
    pending.push({ record, level });
    scheduleFlush(
      pending.length === MAX_PENDING_RECORDS ? 0 : FLUSH_INTERVAL_MS,
    );
    return true;
  };

  const flush = async (): Promise<void> => {
    while (true) {
      await flushBatch();
      if (writeInFlight === undefined && pending.length === 0) {
        return;
      }
    }
  };

  const close = async (finalRecord?: unknown): Promise<void> => {
    if (closed) {
      return;
    }
    if (finalRecord !== undefined) {
      pending.push({ record: finalRecord, level: recordLevel(finalRecord) });
    }
    closed = true;
    await flush();
  };

  return { close, flush, write };
};
