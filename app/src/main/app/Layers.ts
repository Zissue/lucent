import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment";
import * as DesktopGameRendererRecovery from "./DesktopGameRendererRecovery";
import * as DesktopChromiumPerformanceRecording from "./observability/DesktopChromiumPerformanceRecording";
import * as DesktopObservability from "./observability/DesktopObservability";
import * as ArmyConfigRepository from "../game/army/ArmyConfigRepository";
import * as ArmyCoordinator from "../game/army/ArmyCoordinator";
import * as ArmyLoopTauntOrchestrator from "../game/army/ArmyLoopTauntOrchestrator";
import * as AccountRepository from "../game/accounts/AccountRepository";
import * as AccountSettingsRepository from "../game/account-settings/AccountSettingsRepository";
import * as Accounts from "../game/accounts/Accounts";
import * as AccountServers from "../game/accounts/AccountServers";
import * as AccountSessions from "../game/accounts/AccountSessions";
import * as CombatProfiles from "../game/combat-profiles/CombatProfiles";
import * as GameEnvironments from "../game/environment/GameEnvironments";
import * as GameFollowers from "../game/follower/GameFollowers";
import * as GamePackets from "../game/packets/GamePackets";
import * as GameRendererRpc from "../game/rpc/GameRendererRpc";
import * as GitHubApiClient from "../http/GitHubApiClient";
import * as DesktopHttpClient from "../http/DesktopHttpClient";
import * as DesktopIpc from "../ipc/DesktopIpc";
import * as DesktopSettings from "../settings/DesktopSettings";
import * as ScriptInputRepository from "../scripting/ScriptInputRepository";
import * as DesktopScriptLibrary from "../scripting/DesktopScriptLibrary";
import * as GitHubCredentials from "../scripting/GitHubCredentials";
import * as GitHubScriptPackageClient from "../scripting/GitHubScriptPackageClient";
import * as ScriptPackageCatalog from "../scripting/ScriptPackageCatalog";
import * as ScriptPackageManager from "../scripting/ScriptPackageManager";
import * as ScriptPackageState from "../scripting/ScriptPackageState";
import * as ScriptSourceRegistry from "../scripting/ScriptSourceRegistry";
import * as ScriptWorkspace from "../scripting/ScriptWorkspace";
import * as ScriptFileSystem from "../scripting/ScriptFileSystem";
import * as ScriptHttp from "../scripting/ScriptHttp";
import * as DesktopUpdates from "../updates/DesktopUpdates";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu";
import * as DesktopAccountGameWindows from "../window/DesktopAccountGameWindows";
import * as DesktopWindows from "../window/DesktopWindows";
import * as ElectronApp from "../electron/ElectronApp";
import * as ElectronChromiumPerformance from "../electron/ElectronChromiumPerformance";
import * as ElectronDialog from "../electron/ElectronDialog";
import * as GameSessions from "../game/session/GameSessions";
import * as ElectronShell from "../electron/ElectronShell";
import * as ElectronTheme from "../electron/ElectronTheme";
import * as ElectronWindow from "../electron/ElectronWindow";
import * as RuffleSocketProxy from "../game/session/RuffleSocketProxy";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

export const makeDesktopObservabilityLayer = (
  envConfig: DesktopEnvironment.DesktopEnvironmentConfig,
) =>
  DesktopObservability.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(NodeFileSystem.layer, DesktopEnvironment.layer(envConfig)),
    ),
  );

export const makeDesktopLayer = () => {
  const platform = Layer.mergeAll(
    ElectronApp.layer,
    ElectronChromiumPerformance.layer,
    ElectronDialog.layer,
    ElectronShell.layer,
    ElectronTheme.layer,
    ElectronWindow.layer,
    DesktopIpc.layer,
    DesktopHttpClient.layer,
    RuffleSocketProxy.layer,
    AccountSessions.layer,
  );

  const storage = Layer.mergeAll(
    DesktopSettings.layer,
    GameSessions.layer,
    AccountRepository.layer,
    AccountSettingsRepository.layer,
    ArmyConfigRepository.layer,
    CombatProfiles.layer,
    GitHubCredentials.layer,
    ScriptPackageState.layer,
    ScriptInputRepository.layer,
    ScriptWorkspace.layer,
    GitHubApiClient.layer,
  ).pipe(Layer.provideMerge(platform));

  const services = Layer.mergeAll(
    DesktopWindows.layer,
    AccountServers.layer,
    ArmyCoordinator.layer,
    DesktopUpdates.layer,
    ScriptPackageCatalog.layer,
    GitHubScriptPackageClient.layer,
  ).pipe(Layer.provideMerge(storage));

  const game = Layer.mergeAll(
    DesktopAccountGameWindows.layer,
    DesktopChromiumPerformanceRecording.layer,
    GameRendererRpc.layer,
    GamePackets.layer,
    ArmyLoopTauntOrchestrator.layer,
    ScriptFileSystem.layer,
    ScriptHttp.layer,
    ScriptSourceRegistry.layer,
    ScriptPackageManager.layer,
  ).pipe(Layer.provideMerge(services));

  const application = Layer.mergeAll(
    Accounts.layer,
    DesktopApplicationMenu.layer,
    GameEnvironments.layer,
    GameFollowers.layer,
    DesktopScriptLibrary.layer,
  ).pipe(Layer.provideMerge(game));

  return DesktopGameRendererRecovery.layer.pipe(
    Layer.provideMerge(application),
  );
};
