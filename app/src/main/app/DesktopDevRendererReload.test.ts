import { describe, expect, it } from "@effect/vitest";
import type { Stats } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

import {
  reloadUsableRendererContents,
  installDesktopDevRendererReload,
  type RendererReloadContentTarget,
} from "./DesktopDevRendererReload";

const watcher = vi.hoisted(
  (): {
    listener: ((current: Stats, previous: Stats) => void) | undefined;
  } => ({
    listener: undefined,
  }),
);

vi.mock("fs", () => ({
  watchFile: (
    _path: string,
    _options: unknown,
    listener: (current: Stats, previous: Stats) => void,
  ) => {
    watcher.listener = listener;
  },
  unwatchFile: (_path: string, listener: typeof watcher.listener) => {
    if (watcher.listener === listener) watcher.listener = undefined;
  },
}));

vi.mock("effect/Effect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("effect/Effect")>()),
}));

const makeContents = (input: {
  readonly destroyed?: boolean;
  readonly onReload: () => void;
}): RendererReloadContentTarget => ({
  isDestroyed: () => input.destroyed ?? false,
  reloadIgnoringCache: input.onReload,
});

it.live("interrupts in-flight reload logging when its scope closes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "lucent-reload-")),
    );
    const path = join(root, "reload");
    yield* Effect.promise(() => writeFile(path, "initial"));
    const previous = yield* Effect.promise(() => stat(path));
    vi.stubEnv("LUCENT_DEV_RENDERER_RELOAD", path);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: string[] = [];
    const log = vi.spyOn(Effect, "logDebug").mockReturnValue(
      Effect.gen(function* () {
        events.push("started");
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            events.push("interrupted");
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installDesktopDevRendererReload;
          yield* Effect.promise(() => writeFile(path, "changed contents"));
          if (watcher.listener === undefined)
            throw new Error("Missing reload watcher");
          watcher.listener(yield* Effect.promise(() => stat(path)), previous);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
        }),
      );
      expect(events).toEqual(["started", "interrupted"]);
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.ensuring(
        Effect.sync(() => {
          log.mockRestore();
          vi.unstubAllEnvs();
        }),
      ),
      Effect.ensuring(
        Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
    );
  }),
);

describe("reloadUsableRendererContents", () => {
  it("reloads owned renderers only while usable", () => {
    const reloaded: number[] = [];
    const count = reloadUsableRendererContents([
      makeContents({ onReload: () => reloaded.push(1) }),
      makeContents({ onReload: () => reloaded.push(2) }),
      makeContents({
        destroyed: true,
        onReload: () => reloaded.push(3),
      }),
    ]);

    expect(count).toBe(2);
    expect(reloaded).toEqual([1, 2]);
  });
});
