import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { selectDesktopBridge } from "../../../../shared/desktopBridge";
import { ArmyApi } from "../army/Army";
import { Automation } from "../automation/Automation";
import { Environment } from "../environment/Environment";
import { Api } from "../flash/api/Api";
import { ProjectionReadiness } from "../flash/api/ProjectionReadiness";
import { Bridge } from "../flash/bridge/Bridge";
import type { ScriptBuiltinModules } from "./ScriptBuiltinModules";
import { makeScriptBuiltinModules } from "./ScriptBuiltinModules";
import { makeScriptFileSystemApi } from "./ScriptFileSystem";
import { makeScriptHttpApi } from "./ScriptHttp";
import { ScriptDialogs } from "./ScriptDialogs";
import { ScriptRunner } from "./ScriptRunner";
import {
  makeScriptRuntimeApi,
  runScriptExitActions,
  snapshotRoomPolicy,
} from "./ScriptRuntime";
import { makeScriptAsyncScope } from "./scriptAsyncScope";
import {
  getScriptExitRequest,
  ScriptExecutionError,
  ScriptStopSignal,
} from "./ScriptRunnerErrors";
import { makeScriptStartReadiness } from "./ScriptStartReadiness";
import { makeScriptRuntimeServices } from "./api/Services";
import { protectScriptExecution } from "./ScriptExecutionProtection";

const ScriptEvalFunction = Function as unknown as new (
  ...args: string[]
) => (
  api: ScriptBuiltinModules["lucent/api"],
  script: ScriptBuiltinModules["lucent/script"],
  autoRelogin: ScriptBuiltinModules["lucent/autorelogin"],
  autoZone: ScriptBuiltinModules["lucent/autozone"],
  filesystem: ScriptBuiltinModules["lucent/filesystem"],
  http: ScriptBuiltinModules["lucent/http"],
  effect: ScriptBuiltinModules["effect"]["Effect"],
  console: Console,
) => () => Effect.gen.Return<unknown, unknown>;

const compileErrorMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "Script evaluation could not be compiled.";

export const compileScriptEval = (
  source: string,
  modules: ScriptBuiltinModules,
  debugConsole: Console,
): Effect.Effect<unknown, unknown> =>
  Effect.try({
    try: () => {
      const evaluate = new ScriptEvalFunction(
        "api",
        "script",
        "autoRelogin",
        "autoZone",
        "filesystem",
        "http",
        "Effect",
        "console",
        `"use strict";
return function* debugScriptEval() {
${source}
};
//# sourceURL=lucent-script-eval://scratch`,
      );
      return Effect.gen(
        evaluate(
          modules["lucent/api"],
          modules["lucent/script"],
          modules["lucent/autorelogin"],
          modules["lucent/autozone"],
          modules["lucent/filesystem"],
          modules["lucent/http"],
          modules.effect.Effect,
          debugConsole,
        ),
      );
    },
    catch: (cause) =>
      new ScriptExecutionError({
        cause,
        detail: compileErrorMessage(cause),
      }),
  }).pipe(Effect.flatten);

export const runScriptEval = Effect.fn("ScriptEvaluator.runScriptEval")(
  function* (source: string, debugConsole: Console) {
    const {
      fileSystem: fileSystemBridge,
      http: httpBridge,
      gameView,
    } = selectDesktopBridge(window.desktop, "game");
    const api = yield* Api;
    const projectionReadiness = yield* ProjectionReadiness;
    const army = yield* ArmyApi;
    const automation = yield* Automation;
    const environment = yield* Environment;
    const bridge = yield* Bridge;
    const dialogs = yield* ScriptDialogs;
    const runner = yield* ScriptRunner;
    const scope = makeScriptAsyncScope();

    return yield* Effect.gen(function* () {
      const callbackFailure = yield* Deferred.make<never, unknown>();
      const disposeConnectionWatcher = yield* api.events.on(
        { type: "connection" },
        (event) =>
          event.status === "OnConnectionLost" ||
          event.status === "OnConnectionFailed"
            ? Deferred.fail(
                callbackFailure,
                new ScriptStopSignal({ reason: "Connection lost" }),
              ).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* scope.addCleanup(disposeConnectionWatcher);
      const readiness = makeScriptStartReadiness({
        auth: api.auth,
        player: api.player,
        projectionReadiness,
        wait: api.wait,
      });
      const ready = yield* Effect.raceFirst(
        readiness.awaitReady(),
        Deferred.await(callbackFailure),
      );

      yield* runner.bindAccount(ready.username);
      const script = makeScriptRuntimeApi({
        dialogs,
        getOptions: runner.getOptions,
        inputValues: {},
        log: (...values) => debugConsole.log("[script]", ...values),
        scope,
        setOptions: (update) =>
          runner
            .setOptions(update)
            .pipe(Effect.map((result) => result.options)),
        source: { sourceName: "Debug Eval" },
      });
      const http = yield* makeScriptHttpApi(httpBridge, scope);
      const modules = makeScriptBuiltinModules({
        autoRelogin: automation.autoRelogin,
        autoZone: automation.autoZone,
        bridge,
        failCause: (cause: Cause.Cause<unknown>) =>
          Deferred.failCause(callbackFailure, cause).pipe(Effect.asVoid),
        fileSystem: makeScriptFileSystemApi(fileSystemBridge, scope),
        http,
        roomPolicy: runner
          .getOptions()
          .pipe(
            Effect.map((options) => snapshotRoomPolicy(options.roomPolicy)),
          ),
        scope,
        script,
        services: makeScriptRuntimeServices(api, army, environment),
      });

      return yield* Effect.raceFirst(
        protectScriptExecution(
          compileScriptEval(source, modules, debugConsole),
        ),
        Deferred.await(callbackFailure),
      ).pipe(
        Effect.catch((error) =>
          error instanceof ScriptStopSignal
            ? runScriptExitActions(getScriptExitRequest(error), {
                closeClient: gameView.close,
                logout: api.auth.logout,
              }).pipe(Effect.andThen(Effect.fail(error)))
            : Effect.fail(error),
        ),
      );
    }).pipe(Effect.ensuring(scope.close));
  },
);
