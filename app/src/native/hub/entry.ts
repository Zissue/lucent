import { config } from "./install";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as DesktopEnvironment from "../../main/app/DesktopEnvironment";
import * as AccountSettingsRepository from "../../main/game/account-settings/AccountSettingsRepository";
import * as AccountServers from "../../main/game/accounts/AccountServers";
import * as ArmyConfigRepository from "../../main/game/army/ArmyConfigRepository";
import * as ArmyCoordinator from "../../main/game/army/ArmyCoordinator";
import * as ArmyLoopTauntOrchestrator from "../../main/game/army/ArmyLoopTauntOrchestrator";
import * as CombatProfiles from "../../main/game/combat-profiles/CombatProfiles";
import * as GameEnvironments from "../../main/game/environment/GameEnvironments";
import * as DesktopHttpClient from "../../main/http/DesktopHttpClient";
import * as AccountSettingsIpcMethods from "../../main/ipc/methods/accountSettings";
import * as ArmyIpcMethods from "../../main/ipc/methods/army";
import * as CombatProfilesIpcMethods from "../../main/ipc/methods/combatProfiles";
import * as EnvironmentIpcMethods from "../../main/ipc/methods/environment";
import * as FileSystemIpcMethods from "../../main/ipc/methods/filesystem";
import * as HttpIpcMethods from "../../main/ipc/methods/http";
import * as ScriptingIpcMethods from "../../main/ipc/methods/scripting";
import * as SettingsIpcMethods from "../../main/ipc/methods/settings";
import { DesktopIpc } from "../../main/ipc/DesktopIpc";
import * as DesktopScriptLibrary from "../../main/scripting/DesktopScriptLibrary";
import { initializeBundledScriptPackages } from "../../main/scripting/BundledScriptPackages";
import * as GitHubCredentials from "../../main/scripting/GitHubCredentials";
import * as ScriptFileSystem from "../../main/scripting/ScriptFileSystem";
import * as ScriptHttp from "../../main/scripting/ScriptHttp";
import * as ScriptInputRepository from "../../main/scripting/ScriptInputRepository";
import * as ScriptPackageCatalog from "../../main/scripting/ScriptPackageCatalog";
import { basename } from "./node/path";
import * as ScriptPackageState from "../../main/scripting/ScriptPackageState";
import * as ScriptSourceRegistry from "../../main/scripting/ScriptSourceRegistry";
import * as ScriptWorkspace from "../../main/scripting/ScriptWorkspace";
import * as DesktopSettings from "../../main/settings/DesktopSettings";
import { host, onInbound } from "../runtime/host";
import * as NodeFileSystem from "./node/NodeFileSystem";
import {
  closeAccount,
  handlers,
  platformLayer,
  touchAccount,
} from "./platform";

const scriptingChannels = new Set([
  "desktop:scripting:get-input-values",
  "desktop:scripting:save-input-values",
  "desktop:scripting:read-file",
  "desktop:scripting:read-reference",
  "desktop:scripting:load-reference",
  "desktop:scripting:resolve-file",
  "desktop:scripting:resolve-reference",
  "desktop:scripting:open-path",
]);

const methods = [
  ...AccountSettingsIpcMethods.methods,
  ...ArmyIpcMethods.methods,
  ...CombatProfilesIpcMethods.methods,
  ...EnvironmentIpcMethods.methods,
  ...FileSystemIpcMethods.methods,
  ...HttpIpcMethods.methods,
  ...SettingsIpcMethods.methods,
  ...ScriptingIpcMethods.methods.filter((method) =>
    scriptingChannels.has(method.descriptor.channel),
  ),
];

const logger = Logger.make<unknown, void>((options) => {
  const level =
    options.logLevel === "Debug" || options.logLevel === "Trace"
      ? 0
      : options.logLevel === "Info"
        ? 1
        : options.logLevel === "Warn"
          ? 2
          : 3;
  host().log(level, Logger.formatSimple.log(options));
});

const platform = Layer.mergeAll(
  platformLayer,
  NodeFileSystem.layer,
  DesktopEnvironment.layer({
    appDataDir: config.appDataDir,
    assetsDir: config.assetsDir,
    debug: config.debug,
    isDev: config.isDev,
    platform: config.platform,
    workspaceDir: config.workspaceDir,
  }),
  DesktopHttpClient.layer,
  Logger.layer([logger], { mergeWithExisting: false }),
);

const storage = Layer.mergeAll(
  DesktopSettings.layer,
  AccountSettingsRepository.layer,
  ArmyConfigRepository.layer,
  CombatProfiles.layer,
  GitHubCredentials.layer,
  ScriptPackageState.layer,
  ScriptInputRepository.layer,
  ScriptWorkspace.layer,
).pipe(Layer.provideMerge(platform));

const services = Layer.mergeAll(
  AccountServers.layer,
  ArmyCoordinator.layer,
  ScriptPackageCatalog.layer,
).pipe(Layer.provideMerge(storage));

const game = Layer.mergeAll(
  ArmyLoopTauntOrchestrator.layer,
  ScriptFileSystem.layer,
  ScriptHttp.layer,
  ScriptSourceRegistry.layer,
).pipe(Layer.provideMerge(services));

const application = Layer.mergeAll(
  GameEnvironments.layer,
  DesktopScriptLibrary.layer,
).pipe(Layer.provideMerge(game));

const prepareWorkspace = Effect.gen(function* () {
  const workspace = yield* ScriptWorkspace.ScriptWorkspace;
  yield* workspace.initialize;
  yield* initializeBundledScriptPackages;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not prepare the script workspace", cause),
  ),
);

type Invoke = {
  readonly from: number;
  readonly id: number;
  readonly channel: string;
  readonly payload?: unknown;
};

type AppServices =
  | AccountServers.AccountServers
  | ScriptPackageCatalog.ScriptPackageCatalog;

/** Calls from the GPUI app itself, which has no renderer identity. */
const appMethods: Record<
  string,
  (payload: unknown) => Effect.Effect<unknown, unknown, AppServices>
> = {
  "servers.get": () =>
    Effect.gen(function* () {
      return yield* (yield* AccountServers.AccountServers).get;
    }),
  "servers.refresh": () =>
    Effect.gen(function* () {
      return yield* (yield* AccountServers.AccountServers).refresh;
    }),
  "servers.pings": () =>
    Effect.gen(function* () {
      return yield* (yield* AccountServers.AccountServers).getPings;
    }),
  "scripts.describe": (payload) =>
    Effect.gen(function* () {
      const path = String(Reflect.get(Object(payload), "path"));
      const catalog = yield* ScriptPackageCatalog.ScriptPackageCatalog;
      const reference = yield* catalog.referenceForPath(path);
      return {
        name: basename(path),
        path,
        ...(reference === undefined ? {} : { reference }),
      };
    }),
};

let runApp: <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
) => Promise<A> = () => Promise.reject(new Error("The hub is still starting."));

let installed = false;
const waiting: Invoke[] = [];

const handle = ({ from, id, channel, payload }: Invoke): void => {
  touchAccount(from);
  const reply = (envelope: unknown) =>
    host().call("reply", from, id, JSON.stringify(envelope));
  const handler = handlers.get(channel);
  if (handler === undefined) {
    reply({
      ok: false,
      message: `${channel} is not available in the native app.`,
    });
    return;
  }
  handler({ sender: { id: from } }, payload).then(reply, (cause: unknown) =>
    reply({
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
};

const install = Effect.gen(function* () {
  const ipc = yield* DesktopIpc;
  yield* ArmyIpcMethods.installLifecycle();
  yield* CombatProfilesIpcMethods.installEventForwarding();
  yield* SettingsIpcMethods.installEventForwarding();
  for (const method of methods) {
    yield* ipc.handle<
      Effect.Error<ReturnType<typeof method.handler>>,
      Effect.Services<ReturnType<typeof method.handler>>
    >(method);
  }
  runApp = Effect.runPromiseWith(yield* Effect.context<AppServices>());
  installed = true;
  for (const invoke of waiting.splice(0)) handle(invoke);
  yield* prepareWorkspace;
  return yield* Effect.never;
});

onInbound<Invoke>("invoke", (invoke) => {
  if (installed) handle(invoke);
  else waiting.push(invoke);
});

onInbound<{
  readonly id: number;
  readonly method: string;
  readonly payload?: unknown;
}>("app", ({ id, method, payload }) => {
  const reply = (result: unknown) =>
    host().call("appReply", id, JSON.stringify(result));
  const run = appMethods[method];
  if (run === undefined) {
    reply({ ok: false, message: `Unknown hub method ${method}` });
    return;
  }
  runApp(run(payload)).then(
    (value) => reply({ ok: true, value: value ?? null }),
    (cause: unknown) =>
      reply({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );
});

onInbound<{ readonly account: number }>("closed", ({ account }) =>
  closeAccount(account, "closed"),
);
onInbound<{ readonly account: number }>("restarted", ({ account }) =>
  closeAccount(account, "reloaded"),
);

Effect.runFork(
  install.pipe(Effect.provide(application), Effect.scoped),
).addObserver((exit) => {
  host().log(3, `The hub stopped: ${String(exit)}`);
});
