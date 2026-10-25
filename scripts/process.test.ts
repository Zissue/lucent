import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { commandOutput, runCommand } from "./process.mjs";

describe("build commands", () => {
  it.live(
    "preserves stdout whitespace and waits for failure output to drain",
    () =>
      Effect.gen(function* () {
        expect(
          yield* commandOutput(process.execPath, [
            "-e",
            "process.stdout.write('  ready\\n')",
          ]),
        ).toBe("  ready\n");
        const error = yield* commandOutput(process.execPath, [
          "-e",
          "process.stdout.write('x'.repeat(100000)); process.stderr.write('last diagnostic\\n'); process.exitCode = 7;",
        ]).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "CommandFailed", exitCode: 7 });
        expect(error.message).toContain("last diagnostic");
        expect(error.message).toContain("x".repeat(100000));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails on nonzero exit, failed spawn, and signals", () =>
    Effect.gen(function* () {
      expect(
        yield* runCommand(process.execPath, [
          "-e",
          "process.exitCode = 3",
        ]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "CommandFailed", exitCode: 3 });
      const missing = yield* commandOutput(
        "lucent-missing-command-test",
        [],
      ).pipe(Effect.flip);
      expect(missing.message).toContain("lucent-missing-command-test");
      const signal = yield* commandOutput(process.execPath, [
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ]).pipe(Effect.flip);
      expect(signal.message).toContain("SIGTERM");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const stream of ["stdout", "stderr"]) {
    it.live(`bounds captured ${stream} and closes an overflowing process`, () =>
      Effect.gen(function* () {
        const error = yield* commandOutput(
          process.execPath,
          [
            "-e",
            `process.${stream}.write('x'.repeat(4097)); setInterval(() => {}, 1000)`,
          ],
          { maxBytes: 4096 },
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "CommandOutputLimitError",
          maxBytes: 4096,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.live(
    "kills the process group on interruption, including children ignoring SIGTERM",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "lucent-process-test-"))),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const pidFile = join(root, "pids.json");
        const childSource =
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');";
        const source = `
        process.on('SIGTERM', () => {});
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.once('data', () => require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])));
        setInterval(() => {}, 1000);
      `;
        const pending = yield* runCommand(process.execPath, ["-e", source], {
          forceKillAfter: "50 millis",
        }).pipe(Effect.forkScoped);
        const pids = yield* Effect.promise(() =>
          vi.waitFor(
            async () => JSON.parse(await readFile(pidFile, "utf8")) as number[],
          ),
        );
        yield* Fiber.interrupt(pending);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            for (const pid of pids)
              expect(() => process.kill(pid, 0)).toThrow();
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
