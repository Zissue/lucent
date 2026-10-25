import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

export const formatCommand = (
  command: string,
  args: readonly string[],
): string =>
  [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit code ${this.exitCode}${this.output ? `:\n${this.output}` : ""}`;
  }
}

export class CommandOutputLimitError extends Schema.TaggedError<CommandOutputLimitError>()(
  "CommandOutputLimitError",
  {
    command: Schema.String,
    maxBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} exceeded its ${this.maxBytes}-byte output limit`;
  }
}

export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: readonly string[],
  options: Omit<ChildProcess.CommandOptions, "stdout" | "stderr"> = {},
) {
  const child = yield* ChildProcess.make(command, args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    forceKillAfter: "1500 millis",
    ...options,
  });
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0)
    return yield* new CommandFailed({
      command: formatCommand(command, args),
      exitCode,
      output: "",
    });
}, Effect.scoped);

export const commandOutput = Effect.fn("commandOutput")(function* (
  command: string,
  args: readonly string[],
  options: ChildProcess.CommandOptions & { readonly maxBytes?: number } = {},
) {
  const { maxBytes = 1024 * 1024, ...processOptions } = options;
  const label = formatCommand(command, args);
  const child = yield* ChildProcess.make(command, args, {
    forceKillAfter: "1500 millis",
    ...processOptions,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const collect = Effect.fn(function* <E>(
    stream: Stream.Stream<Uint8Array, E>,
  ) {
    let bytes = 0;
    const chunks = yield* stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return bytes > maxBytes
          ? Effect.fail(
              new CommandOutputLimitError({ command: label, maxBytes }),
            )
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    return Buffer.concat(chunks, bytes).toString("utf8");
  });
  const { exitCode, stdout, stderr } = yield* Effect.all(
    {
      exitCode: child.exitCode,
      stdout: collect(child.stdout),
      stderr: collect(child.stderr),
    },
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0)
    return yield* new CommandFailed({
      command: label,
      exitCode,
      output: [stdout, stderr].filter(Boolean).join("\n").trimEnd(),
    });
  return stdout;
}, Effect.scoped);
