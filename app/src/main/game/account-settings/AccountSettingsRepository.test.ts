import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DEFAULT_ACCOUNT_SETTINGS } from "@lucent/core/accountSettings";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import {
  AccountSettingsRepository,
  layer as accountSettingsRepositoryLayer,
} from "./AccountSettingsRepository";

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

const makeRepository = () =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-account-settings-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-account-settings-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    const repository = yield* AccountSettingsRepository.pipe(
      Effect.provide(
        accountSettingsRepositoryLayer.pipe(
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

describe("AccountSettingsRepository", () => {
  it.effect(
    "uses a lowercase username filename without creating defaults",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* makeRepository();
        const path = yield* repository.pathFor("  Hero Name  ");

        expect(path).toMatch(/account-settings\/hero name\.json$/u);
        expect(yield* repository.get("Hero Name")).toEqual(
          DEFAULT_ACCOUNT_SETTINGS,
        );
        expect(
          yield* Effect.promise(() =>
            stat(path).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "normalizes fields independently and preserves siblings on update",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* makeRepository();
        const path = yield* repository.pathFor("Hero");
        yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              scripts: {
                restartAfterReconnect: "invalid",
                roomPolicy: { kind: "specific", roomNumber: 42 },
                safeStartStop: false,
              },
            }),
            "utf8",
          ),
        );

        expect(yield* repository.get("hero")).toMatchObject({
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "specific", roomNumber: 42 },
            safeStartStop: false,
          },
        });

        const updated = yield* repository.update("HERO", {
          scripts: { restartAfterReconnect: true },
        });
        expect(updated.scripts).toEqual({
          restartAfterReconnect: true,
          roomPolicy: { kind: "specific", roomNumber: 42 },
          safeStartStop: false,
        });
      }),
  );

  it.effect("leaves malformed JSON untouched until an edit heals it", () =>
    Effect.gen(function* () {
      const { repository } = yield* makeRepository();
      const path = yield* repository.pathFor("Hero");
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      yield* Effect.promise(() => writeFile(path, "{not-json", "utf8"));

      expect(yield* repository.get("Hero")).toEqual(DEFAULT_ACCOUNT_SETTINGS);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        "{not-json",
      );

      const healed = yield* repository.update("Hero", {
        scripts: { safeStartStop: false },
      });
      expect(healed.scripts.safeStartStop).toBe(false);
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
      ).toEqual(healed);
    }),
  );
});
