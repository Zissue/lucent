import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, layer as testLayer } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { FileSystem } from "effect/FileSystem";
import { layer } from "@effect/platform-node/NodeFileSystem";
import { JSON_FILE_MAX_BYTES, makeJsonFile } from "./JsonFile";
import { desktopLogErrorDetails } from "../../shared/logRecord";

const fixtureDirectories = new Set<string>();

const makeFixture = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "lucent-json-file-"));
  fixtureDirectories.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...fixtureDirectories].map((path) =>
      fs.rm(path, { recursive: true, force: true }),
    ),
  );
  fixtureDirectories.clear();
});

testLayer(layer)("JsonFile", (it) => {
  it.effect("keeps corrupt file contents out of logged parse failures", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const path = join(root, "credentials.json");
      yield* Effect.promise(() =>
        fs.writeFile(path, '{"password": hunter2-secret-token}'),
      );

      const failure = yield* makeJsonFile(yield* FileSystem)
        .read(path)
        .pipe(Effect.flip);
      const logged = desktopLogErrorDetails(failure);

      expect(failure).toMatchObject({
        _tag: "JsonFileError",
        operation: "parse",
      });
      expect(JSON.stringify(logged)).not.toContain("hunter2");
      expect(logged.cause).toMatchObject({
        name: "SyntaxError",
        message: "Invalid JSON",
      });
      expect(logged.cause?.cause).toBeUndefined();
    }),
  );

  it.effect("distinguishes missing files and preserves the JSON format", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const path = join(root, "nested", "state.json");
      const fileSystem = yield* FileSystem;
      const jsonFile = makeJsonFile(fileSystem);

      expect(yield* jsonFile.read(path)).toEqual({ status: "missing" });
      yield* jsonFile.write(path, { enabled: true, count: 2 });

      expect(yield* Effect.promise(() => fs.readFile(path, "utf8"))).toBe(
        '{\n  "enabled": true,\n  "count": 2\n}\n',
      );
      expect(yield* jsonFile.read(path)).toEqual({
        status: "ok",
        value: { enabled: true, count: 2 },
      });
    }),
  );

  it.effect("reports parsing, serialization, and size failures", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const malformedPath = join(root, "malformed.json");
      const oversizedPath = join(root, "oversized.json");
      yield* Effect.promise(() => fs.writeFile(malformedPath, "{"));
      yield* Effect.promise(() =>
        fs.writeFile(oversizedPath, Buffer.alloc(JSON_FILE_MAX_BYTES + 1, 1)),
      );

      const jsonFile = makeJsonFile(yield* FileSystem);
      const parseError = yield* jsonFile.read(malformedPath).pipe(Effect.flip);
      expect(parseError.operation).toBe("parse");

      const serializationError = yield* jsonFile
        .write(join(root, "invalid.json"), undefined)
        .pipe(Effect.flip);
      expect(serializationError.operation).toBe("write");

      const sizeError = yield* jsonFile.read(oversizedPath).pipe(Effect.flip);
      expect(sizeError.operation).toBe("read");
      expect(sizeError.message).toBe(
        `JSON file read failed at ${oversizedPath}. The document exceeds the limit of 8388608 bytes.`,
      );
      expect(sizeError.cause).toMatchObject({
        _tag: "FileSystemLimitError",
        kind: "bytes",
      });
    }),
  );

  it.effect(
    "rejects a write larger than the read limit and keeps the previous file",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(makeFixture);
        const path = join(root, "state.json");
        const jsonFile = makeJsonFile(yield* FileSystem);
        yield* jsonFile.write(path, { version: 1 });

        const result = yield* jsonFile
          .write(path, "\u00e9".repeat(JSON_FILE_MAX_BYTES / 2))
          .pipe(Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "write",
            message: `JSON file write failed at ${path}. The document exceeds the limit of 8388608 bytes.`,
            cause: {
              _tag: "FileSystemLimitError",
              path,
              limit: JSON_FILE_MAX_BYTES,
              kind: "bytes",
            },
          },
        });
        expect(yield* Effect.promise(() => fs.readFile(path, "utf8"))).toBe(
          '{\n  "version": 1\n}\n',
        );
      }),
  );

  it.effect("writes a document exactly at the read limit", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const path = join(root, "state.json");
      const jsonFile = makeJsonFile(yield* FileSystem);
      const value = "a".repeat(JSON_FILE_MAX_BYTES - 3);

      yield* jsonFile.write(path, value);

      expect((yield* Effect.promise(() => fs.stat(path))).size).toBe(
        8 * 1024 * 1024,
      );
      expect(yield* jsonFile.read(path)).toEqual({ status: "ok", value });
    }),
  );

  it.effect("applies creation permissions to the published file", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(makeFixture);
      const path = join(root, "private.json");
      const jsonFile = makeJsonFile(yield* FileSystem);
      yield* jsonFile.write(path, { secret: true }, { mode: 0o600 });

      if (process.platform !== "win32") {
        const info = yield* Effect.promise(() => fs.stat(path));
        expect(info.mode & 0o777).toBe(0o600);
      }
    }),
  );
});
