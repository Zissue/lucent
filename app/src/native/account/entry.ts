import "./install";

import * as Effect from "effect/Effect";

import type { ScriptInputValues } from "@lucent/core/scriptInputs";
import type { ScriptReference } from "@lucent/core/scriptPackages";
import { selectDesktopBridge } from "../../shared/desktopBridge";
import type { GameViewPresentation } from "../../shared/gameViews";
import { gameViewFrameRateLimit } from "../../renderer/apps/game/gameViewFrameRate";
import type { ScriptFile } from "../../shared/ipc/scripting";
import { Automation } from "../../renderer/apps/game/automation/Automation";
import { Api, flashRuntime as runtime } from "../../renderer/apps/game/flash";
import {
  ScriptDialogs,
  type ScriptDialogResponse,
} from "../../renderer/apps/game/scripting/ScriptDialogs";
import { runScriptEval } from "../../renderer/apps/game/scripting/ScriptEvaluator";
import { ScriptRunner } from "../../renderer/apps/game/scripting/ScriptRunner";
import { resolveAccountScript } from "../../renderer/apps/game/scripting/accountScriptResolution";
import { prepareScriptStart } from "../../renderer/apps/game/scripting/scriptStartPreparation";
import { host, onInbound } from "../runtime/host";

const PLAYER_POLL_MS = 1_000;

const emit = (kind: string, payload: unknown): void => {
  host().call("emit", kind, JSON.stringify(payload ?? null));
};

const desktop = selectDesktopBridge(window.desktop, "game");

let current: { file: ScriptFile; inputValues: ScriptInputValues } | null = null;
let boundUsername: string | null = null;

const readReadyUsername = (): Promise<string | undefined> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { player } = yield* Api;
      if (!(yield* player.isReady())) return undefined;
      const self = yield* player.get();
      const username = self?.username.trim();
      return username === undefined || username === "" ? undefined : username;
    }),
  );

const watchPlayer = async (): Promise<void> => {
  try {
    const username = (await readReadyUsername()) ?? null;
    const normalized = username?.toLowerCase() ?? null;
    if (normalized !== boundUsername) {
      boundUsername = normalized;
      if (username !== null) {
        await runtime.runPromise(
          Effect.gen(function* () {
            const runner = yield* ScriptRunner;
            return yield* runner.bindAccount(username);
          }),
        );
      }
      emit("player", { username });
    }
  } catch (cause) {
    console.error("[native:player]", "readiness check failed", cause);
  } finally {
    setTimeout(() => void watchPlayer(), PLAYER_POLL_MS);
  }
};

const describe = (file: ScriptFile) => ({
  name: file.name,
  path: file.path,
  hasInputs: file.inputs !== null,
});

interface Commands {
  readonly login: {
    readonly username: string;
    readonly password: string;
    readonly server?: string;
  };
  readonly "load-script": {
    readonly path: string;
    readonly reference?: ScriptReference;
  };
  readonly "start-script": Record<string, never>;
  readonly "get-inputs": Record<string, never>;
  readonly "save-inputs": { readonly values: Record<string, unknown> };
  readonly "stop-script": Record<string, never>;
  readonly "respond-dialog": { readonly response: ScriptDialogResponse };
  readonly "call-api": {
    readonly path: string;
    readonly args?: readonly unknown[];
  };
  readonly eval: { readonly source: string };
  readonly "set-presentation": GameViewPresentation;
}

const commands: {
  readonly [K in keyof Commands]: (input: Commands[K]) => Promise<unknown>;
} = {
  login: (input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { autoRelogin } = yield* Automation;
        return yield* autoRelogin.runLogin({
          username: input.username,
          password: input.password,
          ...(input.server === undefined ? {} : { server: input.server }),
        });
      }),
    ),
  "load-script": async (input) => {
    const file = await resolveAccountScript(
      (path) =>
        input.reference === undefined
          ? desktop.scripting.resolveFile(path)
          : desktop.scripting.resolveReference(input.reference),
      input.path,
    );
    if (file === null) throw new Error(`Script not found: ${input.path}`);
    const inputValues =
      file.inputs === null
        ? {}
        : await desktop.scripting.getInputValues(file.inputs);
    current = { file, inputValues };
    return describe(file);
  },
  "start-script": async () => {
    if (current === null) throw new Error("Load a script first.");
    const prepared = await prepareScriptStart(current, {
      getInputValues: (definition) =>
        desktop.scripting.getInputValues(definition),
      readFile: (path) =>
        current?.file.reference === undefined
          ? desktop.scripting.readFile(path)
          : desktop.scripting.readReference(current.file.reference),
    });
    current = { file: prepared.file, inputValues: prepared.inputValues };
    if (prepared.status === "missing-required") {
      return { needsInputs: true };
    }
    const handle = await runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ScriptRunner;
        return yield* runner.start(prepared.file, prepared.inputValues);
      }),
    );
    return { needsInputs: false, status: handle.initialStatus };
  },
  "get-inputs": async () =>
    current === null || current.file.inputs === null
      ? null
      : { definition: current.file.inputs, values: current.inputValues },
  "save-inputs": async (input) => {
    if (current === null || current.file.inputs === null) {
      throw new Error("The loaded script has no inputs.");
    }
    const values = await desktop.scripting.saveInputValues(
      current.file.inputs,
      input.values as ScriptInputValues,
    );
    current = { file: current.file, inputValues: values };
    return values;
  },
  "stop-script": () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const runner = yield* ScriptRunner;
        return yield* runner.stop();
      }),
    ),
  "respond-dialog": (input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const dialogs = yield* ScriptDialogs;
        return yield* dialogs.respond(input.response);
      }),
    ),
  "call-api": (input) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const api: object = yield* Api;
        const [group, name] = input.path.split(".");
        const service: unknown =
          group === undefined ? undefined : Reflect.get(api, group);
        const method: unknown =
          typeof service === "object" && service !== null && name !== undefined
            ? Reflect.get(service, name)
            : undefined;
        if (typeof method !== "function") {
          return yield* Effect.fail(
            new Error(`Unknown api method ${input.path}`),
          );
        }
        return yield* (
          method as (
            ...args: readonly unknown[]
          ) => Effect.Effect<unknown, unknown>
        )(...(input.args ?? []));
      }),
    ),
  "set-presentation": (presentation) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const { settings } = yield* Api;
        yield* settings.setFrameRateLimit(gameViewFrameRateLimit(presentation));
      }),
    ),
  eval: (input) => runtime.runPromise(runScriptEval(input.source, console)),
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

onInbound<{
  readonly id: number;
  readonly name: string;
  readonly input?: object;
}>("cmd", ({ id, name, input }) => {
  const command = (
    commands as Record<
      string,
      ((input: object) => Promise<unknown>) | undefined
    >
  )[name];
  const run =
    command === undefined
      ? Promise.reject(new Error(`Unknown command ${name}`))
      : command(input ?? {});
  run.then(
    (value) =>
      host().call(
        "done",
        id,
        JSON.stringify({ ok: true, value: value ?? null }),
      ),
    (cause: unknown) =>
      host().call(
        "done",
        id,
        JSON.stringify({ ok: false, message: errorText(cause) }),
      ),
  );
});

Object.assign(globalThis, {
  onLoaded: () => emit("loaded", null),
  onProgress: (percent: number) => emit("progress", percent),
});

runtime
  .runPromise(
    Effect.gen(function* () {
      const runner = yield* ScriptRunner;
      const dialogs = yield* ScriptDialogs;
      yield* runner.onStatus((status) => emit("script-status", status));
      yield* dialogs.onCurrent((request) => emit("dialog", request));
      emit("script-status", yield* runner.getStatus());
    }),
  )
  .then(
    () => {
      emit("ready", null);
      void watchPlayer();
    },
    (cause: unknown) => {
      console.error("[native]", "the game runtime failed to start", cause);
      emit("failed", errorText(cause));
    },
  );
