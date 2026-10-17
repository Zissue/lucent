import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layer as fileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { JsonFileError, makeJsonFile } from "./JsonFile";
import { makeSavedDocument, type SavedDocumentSpec } from "./SavedDocument";
import { desktopLogErrorDetails } from "../../shared/logRecord";

type Value = {
  readonly version: number;
  readonly enabled: boolean;
  readonly label?: string;
};
const directories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...directories].map((path) => rm(path, { recursive: true, force: true })),
  );
  directories.clear();
});

const fixture = Effect.fnUntraced(function* (
  overrides: Partial<SavedDocumentSpec<Value, JsonFileError>> = {},
  wrap: (fileSystem: FileSystem) => FileSystem = (fileSystem) => fileSystem,
) {
  const root = yield* Effect.promise(() =>
    mkdtemp(join(tmpdir(), "lucent-saved-document-")),
  );
  directories.add(root);
  const path = join(root, "state.json");
  const fileSystem = wrap(
    yield* FileSystem.pipe(Effect.provide(fileSystemLayer)),
  );
  const jsonFile = makeJsonFile(fileSystem);
  const document = yield* makeSavedDocument(jsonFile, {
    kind: "settings",
    path,
    versions: { current: 1, migrations: {} },
    defaults: () => ({ version: 1, enabled: false }),
    decode: (raw) => ({
      value: {
        version: 1,
        enabled: raw["enabled"] === true,
        ...(typeof raw["label"] === "string" ? { label: raw["label"] } : {}),
      },
      issues:
        raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean"
          ? { reset: ["enabled"] }
          : {},
    }),
    encode: (value) => value,
    mapError: (error) => error,
    ...overrides,
  });
  return { root, path, document, jsonFile };
});

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const records: {
    readonly level: string;
    readonly message: unknown;
    readonly annotations: Readonly<Record<string, unknown>>;
    readonly errors: ReadonlyArray<unknown>;
  }[] = [];
  const logger = Logger.make((options) => {
    records.push({
      level: options.logLevel,
      message: options.message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      errors: options.cause.reasons.flatMap((reason) =>
        reason._tag === "Fail" ? [desktopLogErrorDetails(reason.error)] : [],
      ),
    });
  });
  return effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.map((value) => ({ value, records })),
  );
};

describe("SavedDocument", () => {
  it.effect(
    "loads missing defaults without writing and creates the file on save",
    () =>
      Effect.gen(function* () {
        const { root, path, document } = yield* fixture();
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: false },
          records: [],
        });
        expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
        expect(
          yield* capture(document.save({ version: 1, enabled: true })),
        ).toEqual({
          value: { version: 1, enabled: true },
          records: [],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": true\n}\n',
        );
      }),
  );

  it.effect(
    "recovers malformed JSON with a sanitized redacted cause and overwrites on save",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture({
          logPath: "/private/[account].json",
          kind: "account-settings",
        });
        yield* Effect.promise(() => writeFile(path, "{not-json"));
        const loaded = yield* capture(document.load({ diagnostics: true }));
        expect(loaded).toEqual({
          value: { version: 1, enabled: false },
          records: [
            {
              level: "Warn",
              message: [
                "Saved account settings could not be read; using defaults until the next save",
              ],
              annotations: {
                component: "account-settings",
                data: { path: "/private/[account].json", ignored: { file: 1 } },
              },
              errors: [
                expect.objectContaining({
                  name: "JsonFileError",
                  message: "JSON file parse failed at /private/[account].json.",
                  cause: expect.objectContaining({
                    name: "SyntaxError",
                    message: "Invalid JSON at line 1 column 2",
                  }),
                }),
              ],
            },
          ],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          "{not-json",
        );
        const saved = yield* capture(
          document.save({ version: 1, enabled: true }),
        );
        expect(saved).toEqual({
          value: { version: 1, enabled: true },
          records: [],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": true\n}\n',
        );
      }),
  );

  it.effect.each(["[]", "null", "42", '"text"'])(
    "recovers invalid root %s without a parse cause or a load write",
    (source) =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture();
        yield* Effect.promise(() => writeFile(path, source));
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: false },
          records: [
            {
              level: "Warn",
              message: [
                "Saved settings could not be read; using defaults until the next save",
              ],
              errors: [],
              annotations: {
                component: "settings",
                data: { path, ignored: { file: 1 } },
              },
            },
          ],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        expect(
          yield* capture(document.save({ version: 1, enabled: true })),
        ).toEqual({ value: { version: 1, enabled: true }, records: [] });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": true\n}\n',
        );
      }),
  );

  it.effect(
    "uses unreadable policy for a record the domain cannot decode",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture({ decode: () => undefined });
        yield* Effect.promise(() =>
          writeFile(path, '{"version":1,"enabled":true}'),
        );
        const loaded = yield* capture(document.load({ diagnostics: true }));
        expect(loaded.value).toEqual({ version: 1, enabled: false });
        expect(loaded.records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings could not be read; using defaults until the next save",
            ],
            errors: [],
            annotations: {
              component: "settings",
              data: { path, ignored: { file: 1 } },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{"version":1,"enabled":true}',
        );
      }),
  );

  it.effect(
    "returns recovered values and reports invalid fields before overwriting on save",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture();
        yield* Effect.promise(() =>
          writeFile(path, '{"version":1,"enabled":"bad","label":"kept"}'),
        );
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: false, label: "kept" },
          records: [
            {
              level: "Warn",
              message: [
                "Saved settings had invalid entries; ignoring them until the next save",
              ],
              errors: [],
              annotations: {
                component: "settings",
                data: { path, reset: ["enabled"] },
              },
            },
          ],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{"version":1,"enabled":"bad","label":"kept"}',
        );
        expect(
          yield* capture(document.save({ version: 1, enabled: true })),
        ).toEqual({ value: { version: 1, enabled: true }, records: [] });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": true\n}\n',
        );
      }),
  );

  it.effect(
    "propagates typed read failures without logging and saves without rereading",
    () =>
      Effect.gen(function* () {
        let blocked = false;
        const { path, document } = yield* fixture({}, (fileSystem) =>
          FileSystem.of({
            ...fileSystem,
            stream: (path, options) =>
              blocked
                ? Stream.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stream",
                      pathOrDescriptor: path,
                    }),
                  )
                : fileSystem.stream(path, options),
          }),
        );
        yield* Effect.promise(() =>
          writeFile(path, '{"version":1,"enabled":false}'),
        );
        expect(yield* document.load({ diagnostics: true })).toEqual({
          version: 1,
          enabled: false,
        });
        blocked = true;
        const failure = yield* capture(
          document.load({ diagnostics: true }).pipe(Effect.result),
        );
        expect(failure.value).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "JsonFileError", operation: "read", path },
        });
        expect(failure.records).toEqual([]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{"version":1,"enabled":false}',
        );
        expect(
          yield* capture(document.save({ version: 1, enabled: true })),
        ).toEqual({ value: { version: 1, enabled: true }, records: [] });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": true\n}\n',
        );
      }),
  );

  it.effect.each([
    {
      source: '{"version":0,"enabled":true}',
    },
    { source: '{"enabled":true}' },
  ])(
    "migrates $source silently in memory and writes the current version on save",
    ({ source }) =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture();
        yield* Effect.promise(() => writeFile(path, source));
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: true },
          records: [],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        yield* capture(document.save({ version: 1, enabled: false }));

        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": false\n}\n',
        );
      }),
  );

  it.effect(
    "runs every migration step in order and combines retired and invalid field issues",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture({
          decode: (raw) => ({
            value: { version: 2, enabled: raw["enabled"] === true },
            issues: { reset: ["enabled"] },
          }),
          versions: {
            current: 2,
            migrations: {
              0: (raw) => ({
                value: { ...raw, enabled: raw["oldEnabled"] },
                issues: { reset: ["oldEnabled"], ignored: { fields: 1 } },
              }),
              1: (raw) => ({
                value: {
                  ...raw,
                  enabled: raw["version"] === 1 ? raw["enabled"] : false,
                },
                issues: { ignored: { fields: 2 } },
              }),
            },
          },
        });
        yield* Effect.promise(() => writeFile(path, '{"oldEnabled":"bad"}'));
        const loaded = yield* capture(document.load({ diagnostics: true }));
        expect(loaded.value).toEqual({ version: 2, enabled: false });
        expect(loaded.records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings had invalid entries; ignoring them until the next save",
            ],
            errors: [],
            annotations: {
              component: "settings",
              data: {
                path,
                reset: ["oldEnabled", "enabled"],
                ignored: { fields: 3 },
              },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{"oldEnabled":"bad"}',
        );
      }),
  );

  it.effect.each(["null", '"1"', "-1", "1.5"])(
    "treats explicit version %s as damage rather than version zero",
    (version) =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture({
          versions: {
            current: 1,
            migrations: {
              0: () => ({ value: { enabled: false }, issues: {} }),
            },
          },
        });
        yield* Effect.promise(() =>
          writeFile(path, `{"version":${version},"enabled":true}`),
        );
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: true },
          records: [
            {
              level: "Warn",
              message: [
                "Saved settings had invalid entries; ignoring them until the next save",
              ],
              errors: [],
              annotations: {
                component: "settings",
                data: { path, reset: ["version"] },
              },
            },
          ],
        });
      }),
  );

  it.effect(
    "silently decodes newer documents at the current version and saves the current version",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture({
          decode: (raw) => {
            if (raw["version"] !== 1)
              throw new Error("unsupported domain version");
            return {
              value: { version: 1, enabled: raw["enabled"] === true },
              issues: { reset: ["unrecognized"] },
            };
          },
        });
        yield* Effect.promise(() =>
          writeFile(path, '{"version":2,"enabled":true,"futureOnly":"retain"}'),
        );
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: true },
          records: [],
        });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{"version":2,"enabled":true,"futureOnly":"retain"}',
        );
        expect(
          yield* capture(document.save({ version: 1, enabled: false })),
        ).toEqual({ value: { version: 1, enabled: false }, records: [] });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": false\n}\n',
        );
      }),
  );

  it.effect(
    "silently loads current documents with unknown fields and overwrites on save",
    () =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture();
        yield* Effect.promise(() =>
          writeFile(path, '{"version":1,"enabled":true,"futureOnly":"retain"}'),
        );
        expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
          value: { version: 1, enabled: true },
          records: [],
        });
        expect(
          yield* capture(document.save({ version: 1, enabled: false })),
        ).toEqual({ value: { version: 1, enabled: false }, records: [] });
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          '{\n  "version": 1,\n  "enabled": false\n}\n',
        );
      }),
  );

  it.effect.each([
    "{not-json",
    "[]",
    '{"version":1,"enabled":"bad"}',
    '{"version":2,"enabled":true}',
  ])(
    "suppresses recovery diagnostics for a save-seeding read of %s",
    (source) =>
      Effect.gen(function* () {
        const { path, document } = yield* fixture();
        yield* Effect.promise(() => writeFile(path, source));
        const loaded = yield* capture(document.load({ diagnostics: false }));
        expect(loaded.value).toEqual({
          version: 1,
          enabled: source.includes('"enabled":true'),
        });
        expect(loaded.records).toEqual([]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
      }),
  );
});

it.effect(
  "applies every version step before inspecting a clean migrated document",
  () =>
    Effect.gen(function* () {
      const { path, document } = yield* fixture({
        versions: {
          current: 2,
          migrations: {
            0: (raw) => ({
              value: { enabled: raw["legacy"] === "on" },
              issues: {},
            }),
            1: (raw) => ({
              value: {
                ...raw,
                enabled: raw["version"] === 1 && raw["enabled"],
              },
              issues: {},
            }),
          },
        },
        decode: (raw) => ({
          value: {
            version: Number(raw["version"]),
            enabled: raw["enabled"] === true,
          },
          issues:
            typeof raw["enabled"] === "boolean" ? {} : { reset: ["enabled"] },
        }),
      });
      yield* Effect.promise(() => writeFile(path, '{"legacy":"on"}'));
      expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
        value: { version: 2, enabled: true },
        records: [],
      });
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        '{"legacy":"on"}',
      );
    }),
);

it.effect("warns before replacing an undecodable newer document", () =>
  Effect.gen(function* () {
    const { path, document } = yield* fixture({ decode: () => undefined });
    const source = '{"version":2,"enabled":true}';
    yield* Effect.promise(() => writeFile(path, source));
    expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
      value: { version: 1, enabled: false },
      records: [
        {
          level: "Warn",
          message: [
            "Saved settings could not be read; using defaults until the next save",
          ],
          errors: [],
          annotations: {
            component: "settings",
            data: { path, ignored: { file: 1 } },
          },
        },
      ],
    });
    expect(yield* capture(document.load({ diagnostics: false }))).toEqual({
      value: { version: 1, enabled: false },
      records: [],
    });
    expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    expect(
      yield* capture(document.save({ version: 1, enabled: true })),
    ).toEqual({ value: { version: 1, enabled: true }, records: [] });
    expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
      '{\n  "version": 1,\n  "enabled": true\n}\n',
    );
  }),
);

it.effect("passes unchanged versions through a sparse migration map", () =>
  Effect.gen(function* () {
    const { path, document } = yield* fixture({
      versions: {
        current: 3,
        migrations: {
          1: (raw) => ({
            value: {
              enabled: raw["version"] === 1 && raw["legacy"] === "on",
            },
            issues: {},
          }),
        },
      },
      decode: (raw) => ({
        value: {
          version: Number(raw["version"]),
          enabled: raw["enabled"] === true,
        },
        issues: {},
      }),
    });
    const source = '{"version":0,"legacy":"on"}';
    yield* Effect.promise(() => writeFile(path, source));
    expect(yield* capture(document.load({ diagnostics: true }))).toEqual({
      value: { version: 3, enabled: true },
      records: [],
    });
    expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
  }),
);
