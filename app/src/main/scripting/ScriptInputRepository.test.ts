import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  normalizeScriptInputValues,
  type ScriptInputsDefinition,
} from "@lucent/core/scriptInputs";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import {
  ScriptInputRepository,
  layer as scriptInputRepositoryLayer,
} from "./ScriptInputRepository";

const tempDirs = new Set<string>();

const makeTempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

const definition: ScriptInputsDefinition = {
  id: "repository-test",
  fields: [
    {
      key: "target",
      type: "string",
      label: "Target",
      required: true,
    },
    {
      key: "count",
      type: "number",
      label: "Count",
      default: 3,
    },
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      default: false,
    },
    {
      key: "server",
      type: "select",
      label: "Server",
      options: ["Artix", "Yorumi"],
      default: "Artix",
    },
    {
      key: "rewards",
      type: "multi-select",
      label: "Rewards",
      options: ["Weapon", "Armor", "Pet"],
      default: ["Armor"],
    },
  ],
};

const makeRepository = () =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-script-inputs-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-script-inputs-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    const repository = yield* ScriptInputRepository.pipe(
      Effect.provide(
        scriptInputRepositoryLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DesktopEnvironment, env),
              desktopFileSystemLayer,
            ),
          ),
        ),
      ),
    );
    return { env, repository };
  });

describe("ScriptInputRepository service", () => {
  it.effect("normalizes saved values before persisting", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();

      expect(yield* repository.getValues(definition)).toEqual(
        normalizeScriptInputValues(definition, {}),
      );

      const values = yield* repository.saveValues(definition, {
        count: Number.NaN,
        enabled: true,
        rewards: ["Pet", "Weapon", "Removed"],
        server: "Missing",
        target: "chaos",
      });
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "script-inputs.json"), "utf8"),
        ),
      ) as Record<string, unknown>;

      expect(values).toEqual({
        count: 3,
        enabled: true,
        rewards: ["Weapon", "Pet"],
        server: "Artix",
        target: "chaos",
      });
      expect(persisted).toEqual({
        "repository-test": values,
      });
    }),
  );

  it.effect("preserves concurrent saves for different scripts", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const alternateDefinition: ScriptInputsDefinition = {
        ...definition,
        id: "alternate-test",
      };

      const [primaryValues, alternateValues] = yield* Effect.all(
        [
          repository.saveValues(definition, { target: "primary" }),
          repository.saveValues(alternateDefinition, { target: "alternate" }),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "script-inputs.json"), "utf8"),
        ),
      ) as Record<string, unknown>;

      expect(persisted).toEqual({
        "alternate-test": alternateValues,
        "repository-test": primaryValues,
      });
    }),
  );

  it.effect(
    "preserves valid entries when another stored entry is malformed",
    () =>
      Effect.gen(function* () {
        const { env, repository } = yield* makeRepository();
        const path = join(env.appDataDir, "script-inputs.json");
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              "existing-test": { target: "existing" },
              malformed: "not-an-object",
            }),
            "utf8",
          ),
        );

        yield* repository.saveValues(definition, { target: "new" });
        const persisted = JSON.parse(
          yield* Effect.promise(() => readFile(path, "utf8")),
        ) as Record<string, unknown>;

        expect(persisted).toEqual({
          "existing-test": { target: "existing" },
          "repository-test": {
            count: 3,
            enabled: false,
            rewards: ["Armor"],
            server: "Artix",
            target: "new",
          },
        });
      }),
  );
});
