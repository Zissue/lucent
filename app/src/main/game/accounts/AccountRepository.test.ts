import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layer as fileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { AccountRepository, layer } from "./AccountRepository";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

const makeLayer = Effect.gen(function* () {
  const appDataDir = yield* Effect.promise(() =>
    mkdtemp(join(tmpdir(), "lucent-account-repository-")),
  );
  tempDirs.add(appDataDir);
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystemLayer,
        Layer.succeed(DesktopEnvironment, {
          appDataDir,
          assetsDir: join(appDataDir, "assets"),
          isDev: true,
          platform: "darwin",
          workspaceDir: join(appDataDir, "workspace"),
        }),
      ),
    ),
  );
});

describe("AccountRepository", () => {
  it.effect(
    "advances revisions only for changed storage across loads and updates",
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          expect(yield* repository.getWithRevision).toBeNull();
          yield* repository.get;
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: {} },
            revision: 0,
          });
          yield* repository.update((storage) =>
            Effect.succeed({ ...storage, groups: { Raiders: [] } }),
          );
          yield* repository.update((storage) => Effect.succeed({ ...storage }));
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Raiders: [] } },
            revision: 1,
          });
          yield* Effect.promise(() =>
            writeFile(repository.path, '{"accounts":[],"groups":{"Alts":[]}}'),
          );
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Alts: [] } },
            revision: 2,
          });
        }).pipe(Effect.provide(dependencies));
      }),
  );

  it.effect(
    "keeps revisions and storage when a save fails or changes nothing",
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          yield* repository.update((storage) => Effect.succeed({ ...storage }));
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: {} },
            revision: 0,
          });
          yield* repository.update((storage) =>
            Effect.succeed({ ...storage, groups: { Raiders: [] } }),
          );
          yield* Effect.promise(async () => {
            await rm(repository.path);
            await mkdir(repository.path);
          });
          const unchanged = yield* repository.update((storage) =>
            Effect.succeed({ ...storage }),
          );
          expect(unchanged).toEqual({ accounts: [], groups: { Raiders: [] } });
          const error = yield* repository
            .update((storage) =>
              Effect.succeed({ ...storage, groups: { Alts: [] } }),
            )
            .pipe(Effect.flip);
          expect(error.operation).toBe("rename");
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Raiders: [] } },
            revision: 1,
          });
        }).pipe(Effect.provide(dependencies));
      }),
  );
});
