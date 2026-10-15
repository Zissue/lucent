import type { RendererLogRecord } from "./ipc/rendererLog";
import type { RecentlyClosedGameSession } from "@lucent/core/accounts";
import type {
  AppSettings,
  AppearancePatch,
  PreferencesPatch,
} from "@lucent/core/settings";
import type {
  EnvironmentAutomationCapability,
  EnvironmentItemRules,
  EnvironmentQuestAutoRegisterOptions,
  EnvironmentQuestRegistration,
  EnvironmentState,
} from "@lucent/core/environment";
import type { HotkeysPatch } from "@lucent/core/hotkeys";
import type {
  CombatProfile,
  CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import type {
  FollowerConfig,
  FollowerStartPayload,
  FollowerState,
} from "@lucent/core/follower";
import type {
  FileSystemEntry,
  FileSystemFailure,
} from "@lucent/core/filesystem";
import type {
  ArmyConfigPayload,
  ArmyFailPayload,
  ArmyLoopTauntCommandPayload,
  ArmyLoopTauntLeavePayload,
  ArmyLoopTauntRegisterPayload,
  ArmyLoopTauntRegisterResult,
  ArmyLoopTauntReportPayload,
  ArmyLoopTauntRunPayload,
  ArmyLoopTauntTerminalResult,
  ArmyProgressPayload,
  ArmyProgressResult,
  ArmySessionEndedPayload,
  ArmySessionPayload,
  ArmyStartPayload,
  ArmySyncPayload,
} from "@lucent/core/army";
import type {
  ScriptFile,
  ScriptFileResolution,
  ScriptOpenFileResult,
  ScriptSelectFileResult,
} from "./ipc/scripting";
import type { EnvironmentBoostDiscovery } from "./environmentBoosts";
import type { DesktopHttpBridge } from "./http";
import type { FollowerPlayers } from "./ipc/follower";
import type {
  ScriptInputsDefinition,
  ScriptInputValues,
} from "@lucent/core/scriptInputs";
import type {
  GitHubCredentialSummary,
  GitHubCredentialWrite,
  ScriptCatalogChange,
  ScriptCatalogOverview,
  ScriptCatalogPage,
  ScriptCatalogPageRequest,
  ScriptPackageInstallRequest,
  ScriptPackageMutationResult,
  ScriptPackageRemoveRequest,
  ScriptPackageUpdateRequest,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import type { UpdateCheckState } from "./updates";
import type { AboutFolder, AboutInfo, AboutLink } from "./ipc/about";
import type {
  AccountGameLaunchPayload,
  AccountGameServerPingsResult,
  AccountGameServersResult,
  AccountGameWindowTargetRequest,
  AccountLaunchRequest,
  AccountLaunchResult,
  AccountManagerState,
  AccountSessionReport,
  ManagedAccountDraft,
  ManagedAccountGroupDraft,
  ManagedAccountGroupPatch,
  ManagedAccountPatch,
} from "@lucent/core/accounts";
import type {
  AccountSettings,
  AccountSettingsPatch,
} from "@lucent/core/accountSettings";
import type {
  GrabbedData,
  LoaderGrabberGrabRequest,
  LoaderGrabberLoadRequest,
} from "./loader-grabber";
import type {
  PacketCapturedPayload,
  PacketQueuePayload,
  PacketSendPayload,
  PacketsStatusPayload,
} from "./packets";
import type {
  GameViewGroupCommandDispatchResult,
  GameViewGroupCommandDispatchRequest,
  GameViewGroupCommandEnvelope,
  GameViewGroupOptionHotkeyCommandId,
  GameViewHostState,
  GameViewLayout,
  GameViewPresentation,
  GameViewSelectionFocus,
} from "./gameViews";

export type AppPlatform = "linux" | "mac" | "windows";
export type DesktopBridgeView =
  | "about"
  | "account-manager"
  | "combat-profiles"
  | "environment"
  | "follower"
  | "game"
  | "game-group-controls"
  | "game-host"
  | "loader-grabber"
  | "packets"
  | "settings";
export type DesktopBridgeWindowKind =
  | "about"
  | "account-manager"
  | "combat-profiles"
  | "environment"
  | "follower"
  | "game"
  | "loader-grabber"
  | "packets"
  | "settings";

export interface DesktopSettingsBridge {
  readonly initial: AppSettings | null;
  readonly get: () => Promise<AppSettings>;
  readonly onChanged: (listener: (settings: AppSettings) => void) => () => void;
}

export interface DesktopSettingsManagementBridge extends DesktopSettingsBridge {
  readonly resetAppearance: () => Promise<AppSettings>;
  readonly resetHotkeys: () => Promise<AppSettings>;
  readonly updateAppearance: (patch: AppearancePatch) => Promise<AppSettings>;
  readonly updateHotkeys: (patch: HotkeysPatch) => Promise<AppSettings>;
  readonly updatePreferences: (patch: PreferencesPatch) => Promise<AppSettings>;
}

export interface DesktopUpdatesBridge {
  readonly checkNow: (options?: {
    readonly force?: boolean;
  }) => Promise<UpdateCheckState>;
  readonly getState: () => Promise<UpdateCheckState>;
  readonly onChanged: (
    listener: (state: UpdateCheckState) => void,
  ) => () => void;
  readonly openReleasePage: () => Promise<boolean>;
}

export interface DesktopAboutBridge {
  readonly getInfo: () => Promise<AboutInfo>;
  readonly openFolder: (folder: AboutFolder) => Promise<boolean>;
  readonly openLink: (link: AboutLink) => Promise<boolean>;
}

export interface DesktopScriptingBridge {
  readonly checkPackageUpdate: (
    packageName: string,
  ) => Promise<ScriptCatalogOverview>;
  readonly deleteCredential: (id: string) => Promise<void>;
  readonly getCatalog: () => Promise<ScriptCatalogOverview>;
  readonly getCatalogPage: (
    request: ScriptCatalogPageRequest,
  ) => Promise<ScriptCatalogPage>;
  readonly getInputValues: (
    definition: ScriptInputsDefinition,
  ) => Promise<ScriptInputValues>;
  readonly loadReference: (reference: ScriptReference) => Promise<ScriptFile>;
  readonly installPackage: (
    request: ScriptPackageInstallRequest,
  ) => Promise<ScriptPackageMutationResult>;
  readonly listCredentials: () => Promise<readonly GitHubCredentialSummary[]>;
  readonly openFile: () => Promise<ScriptOpenFileResult>;
  readonly openPath: (path: string) => Promise<boolean>;
  readonly openRepository: (repositoryUrl: string) => Promise<boolean>;
  readonly onCatalogChanged: (
    listener: (change: ScriptCatalogChange) => void,
  ) => () => void;
  readonly readFile: (path: string) => Promise<ScriptFile>;
  readonly readReference: (reference: ScriptReference) => Promise<ScriptFile>;
  readonly refreshCatalog: () => Promise<ScriptCatalogOverview>;
  readonly removePackage: (
    request: ScriptPackageRemoveRequest,
  ) => Promise<ScriptPackageMutationResult>;
  readonly resolveFile: (path: string) => Promise<ScriptFileResolution>;
  readonly resolveReference: (
    reference: ScriptReference,
  ) => Promise<ScriptFileResolution>;
  readonly selectFile: () => Promise<ScriptSelectFileResult>;
  readonly saveInputValues: (
    definition: ScriptInputsDefinition,
    values: ScriptInputValues,
  ) => Promise<ScriptInputValues>;
  readonly saveCredential: (
    credential: GitHubCredentialWrite,
  ) => Promise<GitHubCredentialSummary>;
  readonly updatePackage: (
    request: ScriptPackageUpdateRequest,
  ) => Promise<ScriptPackageMutationResult>;
}

export interface DesktopCombatProfilesBridge {
  readonly deleteProfile: (profileId: string) => Promise<CombatProfileLibrary>;
  readonly getState: () => Promise<CombatProfileLibrary>;
  readonly onChanged: (
    listener: (library: CombatProfileLibrary) => void,
  ) => () => void;
  readonly saveProfile: (
    profile: CombatProfile,
  ) => Promise<CombatProfileLibrary>;
}

export interface DesktopAccountsBridge {
  readonly closeGameWindow: (
    request: AccountGameWindowTargetRequest,
  ) => Promise<AccountManagerState>;
  readonly closeGameWindows: (
    gameWindowIds: readonly number[],
  ) => Promise<AccountManagerState>;
  readonly createAccount: (
    draft: ManagedAccountDraft,
  ) => Promise<AccountManagerState>;
  readonly createGroup: (
    draft: ManagedAccountGroupDraft,
  ) => Promise<AccountManagerState>;
  readonly deleteAccount: (username: string) => Promise<AccountManagerState>;
  readonly deleteAccounts: (
    usernames: readonly string[],
  ) => Promise<AccountManagerState>;
  readonly deleteGroup: (name: string) => Promise<AccountManagerState>;
  readonly focusGameWindow: (
    request: AccountGameWindowTargetRequest,
  ) => Promise<AccountManagerState>;
  readonly getServerPings: () => Promise<AccountGameServerPingsResult>;
  readonly getServers: () => Promise<AccountGameServersResult>;
  readonly getState: () => Promise<AccountManagerState>;
  readonly launch: (
    request: AccountLaunchRequest,
  ) => Promise<AccountLaunchResult>;
  readonly onChanged: (
    listener: (state: AccountManagerState) => void,
  ) => () => void;
  readonly refreshServers: () => Promise<AccountGameServersResult>;
  readonly updateAccount: (
    username: string,
    patch: ManagedAccountPatch,
  ) => Promise<AccountManagerState>;
  readonly updateGroup: (
    name: string,
    patch: ManagedAccountGroupPatch,
  ) => Promise<AccountManagerState>;
}

export interface DesktopGameAccountsBridge {
  readonly getGameLaunch: () => Promise<AccountGameLaunchPayload | null>;
  readonly prepareGameLoadRecovery: () => Promise<void>;
  readonly reportSession: (report: AccountSessionReport) => Promise<void>;
}

export interface DesktopAccountSettingsBridge {
  readonly get: (username: string) => Promise<AccountSettings>;
  readonly update: (
    username: string,
    patch: AccountSettingsPatch,
  ) => Promise<AccountSettings>;
}

export interface DesktopGameConsoleObservabilityBridge {
  readonly message: (method: string, message: string) => void;
}

export interface DesktopGameRendererBridge {
  /** Arms main-process recovery while script-authored JavaScript can run. */
  readonly beginScriptExecution: () => Promise<number>;
  /** Disarms a completed script execution without affecting concurrent runs. */
  readonly finishScriptExecution: (token: number) => Promise<void>;
  /** Reads the generation assigned to this game document. */
  readonly getGeneration: () => Promise<number>;
  /** Marks the current game renderer generation ready to receive commands. */
  readonly ready: (generation: number) => Promise<void>;
}

export type DesktopFileSystemResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly error: FileSystemFailure; readonly ok: false };

export interface DesktopFileSystemBridge {
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly exists: (
    sessionId: string,
    path: string,
  ) => Promise<DesktopFileSystemResult<boolean>>;
  readonly list: (
    sessionId: string,
    path?: string,
  ) => Promise<DesktopFileSystemResult<readonly FileSystemEntry[]>>;
  readonly openSession: () => Promise<string>;
  readonly readJson: (
    sessionId: string,
    path: string,
  ) => Promise<DesktopFileSystemResult<unknown | undefined>>;
  readonly readText: (
    sessionId: string,
    path: string,
  ) => Promise<DesktopFileSystemResult<string | undefined>>;
  readonly remove: (
    sessionId: string,
    path: string,
  ) => Promise<DesktopFileSystemResult<void>>;
  readonly writeJson: (
    sessionId: string,
    path: string,
    value: unknown,
  ) => Promise<DesktopFileSystemResult<void>>;
  readonly writeText: (
    sessionId: string,
    path: string,
    contents: string,
  ) => Promise<DesktopFileSystemResult<void>>;
}

export interface DesktopGameViewHostBridge {
  readonly getRecentlyClosed: () => Promise<
    readonly RecentlyClosedGameSession[]
  >;
  readonly reopen: (id: number) => Promise<GameViewHostState>;
  readonly add: () => Promise<GameViewHostState>;
  readonly close: (id: string) => Promise<void>;
  readonly dispatchGroupCommand: (
    request: GameViewGroupCommandDispatchRequest,
  ) => Promise<GameViewGroupCommandDispatchResult>;
  readonly getState: () => Promise<GameViewHostState>;
  readonly onChanged: (
    listener: (state: GameViewHostState) => void,
  ) => () => void;
  readonly onShortcutModifierChanged: (
    listener: (pressed: boolean) => void,
  ) => () => void;
  readonly onTabMenuOpenChanged: (
    listener: (open: boolean) => void,
  ) => () => void;
  readonly reorder: (ids: readonly string[]) => Promise<GameViewHostState>;
  readonly select: (
    id: string,
    focus: GameViewSelectionFocus,
  ) => Promise<GameViewHostState>;
  readonly setGroupControlsOpen: (open: boolean) => Promise<GameViewHostState>;
  readonly setGroupTargets: (
    ids: readonly string[],
  ) => Promise<GameViewHostState>;
  readonly setLayout: (layout: GameViewLayout) => Promise<GameViewHostState>;
  readonly setTabMenuOpen: (open: boolean) => Promise<boolean>;
  readonly syncTabBarLayout: () => Promise<void>;
}

export interface DesktopGameViewBridge {
  readonly close: () => void;
  readonly dispatchGroupOptionHotkey: (
    commandId: GameViewGroupOptionHotkeyCommandId,
  ) => Promise<GameViewGroupCommandDispatchResult>;
  readonly getPresentation: () => Promise<GameViewPresentation>;
  /** Layout known by the main process before the game document loads. */
  readonly initialLayout: GameViewLayout | null;
  readonly onGroupCommand: (
    listener: (envelope: GameViewGroupCommandEnvelope) => void,
  ) => () => void;
  readonly onPresentationChanged: (
    listener: (presentation: GameViewPresentation) => void,
  ) => () => void;
}

export interface DesktopWindowsBridge {
  readonly open: (kind: DesktopBridgeWindowKind) => Promise<string>;
}

export interface DesktopLoaderGrabberWindowBridge {
  readonly grab: (
    payload: LoaderGrabberGrabRequest,
  ) => Promise<GrabbedData | null>;
  readonly load: (payload: LoaderGrabberLoadRequest) => Promise<void>;
}

export interface DesktopPacketsWindowBridge {
  readonly getStatus: () => Promise<PacketsStatusPayload>;
  readonly onCaptured: (
    listener: (payload: PacketCapturedPayload) => void,
  ) => () => void;
  readonly onStatus: (
    listener: (payload: PacketsStatusPayload) => void,
  ) => () => void;
  readonly send: (payload: PacketSendPayload) => Promise<void>;
  readonly startCapture: () => Promise<void>;
  readonly startQueue: (payload: PacketQueuePayload) => Promise<void>;
  readonly stopCapture: () => Promise<void>;
  readonly stopQueue: () => Promise<void>;
}

export interface DesktopGamePacketsBridge {
  readonly publishCaptured: (payload: PacketCapturedPayload) => Promise<void>;
  readonly publishStatus: (payload: PacketsStatusPayload) => Promise<void>;
}

export interface DesktopFollowerBridge {
  readonly configure: (payload: FollowerStartPayload) => Promise<FollowerState>;
  readonly getConfig: () => Promise<FollowerConfig | null>;
  readonly getPlayers: () => Promise<FollowerPlayers>;
  readonly getState: () => Promise<FollowerState>;
  readonly me: () => Promise<string>;
  readonly onChanged: (listener: (state: FollowerState) => void) => () => void;
  readonly onPlayersChanged: (
    listener: (players: FollowerPlayers) => void,
  ) => () => void;
  readonly start: (payload: FollowerStartPayload) => Promise<FollowerState>;
  readonly stop: () => Promise<FollowerState>;
}

export interface DesktopGameFollowerBridge {
  readonly publishPlayers: (players: FollowerPlayers) => Promise<void>;
  readonly publishState: (state: FollowerState) => Promise<void>;
}

export interface DesktopEnvironmentBridge {
  readonly addBoost: (name: string) => Promise<EnvironmentState>;
  readonly addBoosts: (names: readonly string[]) => Promise<EnvironmentState>;
  readonly addItem: (name: string) => Promise<EnvironmentState>;
  readonly addItems: (names: readonly string[]) => Promise<EnvironmentState>;
  readonly addQuest: (
    questId: number,
    rewardItemId?: number,
  ) => Promise<EnvironmentState>;
  readonly addQuests: (
    quests: readonly EnvironmentQuestRegistration[],
  ) => Promise<EnvironmentState>;
  readonly clear: () => Promise<EnvironmentState>;
  readonly clearBoosts: () => Promise<EnvironmentState>;
  readonly clearItems: () => Promise<EnvironmentState>;
  readonly clearQuestReward: (questId: number) => Promise<EnvironmentState>;
  readonly clearQuests: () => Promise<EnvironmentState>;
  readonly fetchBoosts: () => Promise<EnvironmentBoostDiscovery>;
  readonly getState: () => Promise<EnvironmentState>;
  readonly onChanged: (
    listener: (state: EnvironmentState) => void,
  ) => () => void;
  readonly removeBoost: (name: string) => Promise<EnvironmentState>;
  readonly removeItem: (name: string) => Promise<EnvironmentState>;
  readonly removeQuest: (questId: number) => Promise<EnvironmentState>;
  readonly setAutomationEnabled: (
    capability: EnvironmentAutomationCapability,
    enabled: boolean,
  ) => Promise<EnvironmentState>;
  readonly setItemNotification: (
    name: string,
    enabled: boolean,
  ) => Promise<EnvironmentState>;
  readonly setItemRules: (
    rules: EnvironmentItemRules,
  ) => Promise<EnvironmentState>;
  readonly setQuestAutoRegister: (
    options: EnvironmentQuestAutoRegisterOptions,
  ) => Promise<EnvironmentState>;
  readonly setQuestReward: (
    questId: number,
    rewardItemId: number,
  ) => Promise<EnvironmentState>;
  readonly syncToAll: () => Promise<EnvironmentState>;
  readonly withdrawBoosts: (
    itemIds: readonly number[],
  ) => Promise<readonly number[]>;
}

export interface DesktopArmyBridge {
  readonly fail: (payload: ArmyFailPayload) => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly loadConfig: (configName: string) => Promise<ArmyConfigPayload>;
  readonly loopTauntAwait: (
    payload: ArmyLoopTauntRunPayload,
  ) => Promise<ArmyLoopTauntTerminalResult>;
  readonly loopTauntLeave: (
    payload: ArmyLoopTauntLeavePayload,
  ) => Promise<void>;
  readonly loopTauntRegister: (
    payload: ArmyLoopTauntRegisterPayload,
  ) => Promise<ArmyLoopTauntRegisterResult>;
  readonly loopTauntReport: (
    payload: ArmyLoopTauntReportPayload,
  ) => Promise<void>;
  readonly loopTauntReady: (payload: ArmyLoopTauntRunPayload) => Promise<void>;
  readonly onEnded: (
    listener: (payload: ArmySessionEndedPayload) => void,
  ) => () => void;
  readonly onLoopTauntCommand: (
    listener: (payload: ArmyLoopTauntCommandPayload) => void,
  ) => () => void;
  readonly progress: (
    payload: ArmyProgressPayload,
  ) => Promise<ArmyProgressResult>;
  readonly start: (payload: ArmyStartPayload) => Promise<ArmySessionPayload>;
  readonly sync: (payload: ArmySyncPayload) => Promise<void>;
}

export interface DesktopLogBridge {
  readonly error: (message: string, error?: unknown) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly info: (message: string, error?: unknown) => void;
  readonly debug: (message: string, error?: unknown) => void;
  readonly write: (record: RendererLogRecord) => void;
}

interface DesktopBridgeBase {
  readonly log: DesktopLogBridge;
  readonly debug: boolean;
  readonly platform: {
    readonly os: AppPlatform;
  };
}

interface DesktopBridgeCapabilities {
  readonly http: DesktopHttpBridge;
  readonly accountSettings: DesktopAccountSettingsBridge;
  readonly accounts: DesktopAccountsBridge;
  readonly army: DesktopArmyBridge;
  readonly combatProfiles: DesktopCombatProfilesBridge;
  readonly environment: DesktopEnvironmentBridge;
  readonly follower: DesktopFollowerBridge;
  readonly fileSystem: DesktopFileSystemBridge;
  readonly gameAccounts: DesktopGameAccountsBridge;
  readonly gameConsoleObservability: DesktopGameConsoleObservabilityBridge;
  readonly gameFollower: DesktopGameFollowerBridge;
  readonly gameRenderer: DesktopGameRendererBridge;
  readonly gameView: DesktopGameViewBridge;
  readonly gameViewHost: DesktopGameViewHostBridge;
  readonly scripting: DesktopScriptingBridge;
  readonly updates: DesktopUpdatesBridge;
  readonly windows: DesktopWindowsBridge;
}

interface DesktopBridgeViewCapabilities {
  readonly about: Pick<DesktopBridgeCapabilities, "updates"> & {
    readonly about: DesktopAboutBridge;
  };
  readonly "account-manager": Pick<
    DesktopBridgeCapabilities,
    "accounts" | "scripting"
  >;
  readonly "combat-profiles": Pick<DesktopBridgeCapabilities, "combatProfiles">;
  readonly environment: Pick<DesktopBridgeCapabilities, "environment">;
  readonly follower: Pick<
    DesktopBridgeCapabilities,
    "combatProfiles" | "follower" | "windows"
  >;
  readonly game: Pick<
    DesktopBridgeCapabilities,
    | "accountSettings"
    | "army"
    | "combatProfiles"
    | "environment"
    | "fileSystem"
    | "http"
    | "gameAccounts"
    | "gameFollower"
    | "gameRenderer"
    | "gameView"
    | "scripting"
    | "windows"
  > & {
    readonly packets: DesktopGamePacketsBridge;
  } & Partial<Pick<DesktopBridgeCapabilities, "gameConsoleObservability">>;
  readonly "game-group-controls": Pick<
    DesktopBridgeCapabilities,
    "gameViewHost"
  >;
  readonly "loader-grabber": {
    readonly loaderGrabber: DesktopLoaderGrabberWindowBridge;
  };
  readonly "game-host": Pick<DesktopBridgeCapabilities, "gameViewHost">;
  readonly packets: {
    readonly packets: DesktopPacketsWindowBridge;
  };
  readonly settings: Pick<DesktopBridgeCapabilities, "updates">;
}

export type DesktopBridgeFor<View extends DesktopBridgeView> =
  DesktopBridgeBase & {
    readonly settings: View extends "settings"
      ? DesktopSettingsManagementBridge
      : DesktopSettingsBridge;
    readonly view: View;
  } & DesktopBridgeViewCapabilities[View];

export type DesktopBridgeByView = {
  readonly [View in DesktopBridgeView]: DesktopBridgeFor<View>;
};

export type DesktopBridge = DesktopBridgeByView[DesktopBridgeView];

/** Selects the bridge for a renderer entry point and rejects a mismatched view. */
export function selectDesktopBridge<View extends DesktopBridgeView>(
  bridge: DesktopBridge,
  view: View,
): DesktopBridgeFor<View>;
export function selectDesktopBridge(
  bridge: DesktopBridge,
  view: DesktopBridgeView,
): DesktopBridge {
  if (bridge.view !== view) {
    throw new Error(
      `Expected the ${view} desktop bridge, received ${bridge.view}.`,
    );
  }

  return bridge;
}
