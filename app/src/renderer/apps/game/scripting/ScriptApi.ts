import type {
  AuraQueryOptions,
  BoostType,
  EntityState,
  InventoryPool,
  ItemQuery,
  LiveAura,
  LiveFaction,
  LiveItem,
  LiveMonster,
  LiveOutfit,
  LivePlayer,
  LiveQuest,
  LiveServer,
  LiveShop,
  MonsterQuery,
  PlayerQuery,
  Position,
  ShopItemQuery,
} from "@lucent/game";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type { RoomPolicy } from "@lucent/core/accountSettings";
import type {
  EnvironmentAutomationCapability,
  EnvironmentAutomationOptions,
  EnvironmentDropPolicy,
  EnvironmentQuestAutoRegisterOptions,
} from "@lucent/core/environment";
import type {
  ScriptInputsDefinition,
  ScriptInputValue,
  ScriptInputValues,
} from "@lucent/core/scriptInputs";
import type {
  ArmyEquipSetOptions,
  ArmyError,
  ArmyRunStepOptions,
  ArmySession,
} from "../army/Army";
import type {
  ArmyLoopTauntError,
  ArmyLoopTauntHandle,
  ArmyLoopTauntPlan,
} from "../army/ArmyLoopTaunt";
import type { AutoReloginState } from "../automation/AutoRelogin";
import type {
  AutoZoneState,
  AutoZoneSupportedMap,
} from "../automation/AutoZone";
import type { ConnectOutcome } from "../flash/api/Auth";
import type { BankOpenOptions } from "../flash/api/Bank";
import type {
  CombatKillOptions,
  HuntOptions,
  SkillSlot,
  SkillUseOptions,
} from "../flash/api/Combat";
import type { EquipOptions } from "../flash/api/Inventory";
import type { CellPositionOptions } from "../flash/api/Map";
import type {
  ClientPacketEncoding,
  ServerPacketEncoding,
} from "../flash/api/Packet";
import type { RestOptions, WalkToOptions } from "../flash/api/Player";
import type { CompleteQuestOptions } from "../flash/api/Quests";

import type {
  ProjectionEvent,
  ProjectionEventSelector,
} from "../flash/contract/Event";
import type { GameAction } from "../flash/contract/GameAction";
import type {
  Packet,
  PacketDirection,
  PacketForDirection,
  PacketSelector,
  WaitOptions,
} from "../flash/contract/Packet";
import type { TriggeredWaitOptions } from "../flash/protocol/Wait";
import type { ScriptCallbackResult, ScriptGenerator } from "./api/Callbacks";
import type {
  ScriptExecutionError,
  ScriptStopSignal,
} from "./ScriptRunnerErrors";

export type ScriptEffect<A = unknown, E = unknown> = Effect.Effect<A, E>;

export type { ScriptCallbackResult, ScriptGenerator };

export type { ScriptInputType } from "@lucent/core/scriptInputs";

export type { ScriptInputsDefinition, ScriptInputValue, ScriptInputValues };
export type { RoomPolicy };

/** Identifies the item and minimum quantity a farming action should collect. */
export interface FarmItemGoal {
  readonly item: ItemQuery;
  /** @defaultValue 1 */
  readonly quantity?: number;
}

export type ScriptEvent = ProjectionEvent;
export type ScriptEventType = ScriptEvent["type"];
export type ScriptEventSelector = ProjectionEventSelector;

export type ScriptEventForType<T extends ScriptEventType> = Extract<
  ScriptEvent,
  { readonly type: T }
>;

export type ScriptEventSelectorForType<T extends ScriptEventType> =
  ScriptEventSelector & {
    readonly type: T;
  };

export interface ScriptArmyApi {
  readonly equipSet: (
    setName: string,
    options?: ArmyEquipSetOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly getConfigString: (
    key: string,
    defaultValue?: string,
  ) => Effect.Effect<string>;
  readonly getConfigValue: (
    key: string,
    defaultValue?: unknown,
  ) => Effect.Effect<unknown>;
  readonly getPlayerNumber: () => Effect.Effect<number | null>;
  readonly getSession: () => Effect.Effect<ArmySession | null>;
  readonly isLeader: () => Effect.Effect<boolean>;
  readonly isMember: () => Effect.Effect<boolean>;
  readonly isStarted: () => Effect.Effect<boolean>;
  readonly joinMap: (
    map: string,
    options?: CellPositionOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly kill: (
    target: MonsterQuery,
    options?: CombatKillOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly killForItem: (
    target: MonsterQuery,
    goal: FarmItemGoal,
    options?: CombatKillOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly killForTempItem: (
    target: MonsterQuery,
    goal: FarmItemGoal,
    options?: CombatKillOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly leave: () => Effect.Effect<void>;
  readonly runStep: <A, E>(
    label: string,
    action: Effect.Effect<A, E>,
    options?: ArmyRunStepOptions,
  ) => Effect.Effect<A, E | ArmyError>;
  readonly start: (configName: string) => Effect.Effect<ArmySession, ArmyError>;
  /**
   * Starts a map-scoped Loop Taunt plan across the full Army roster.
   *
   * @param plan The ordered target priority groups every participant runs.
   */
  readonly loopTaunt: (
    plan: ArmyLoopTauntPlan,
  ) => Effect.Effect<ArmyLoopTauntHandle, ArmyLoopTauntError>;
  /** @param label The coordination label. */
  readonly sync: (
    /** @defaultValue "sync" */
    label?: string,
    options?: ArmyRunStepOptions,
  ) => Effect.Effect<void, ArmyError>;
  readonly waitForAllInMap: () => Effect.Effect<void, ArmyError>;
}

export interface ScriptAuthApi {
  readonly connectTo: (server: string) => Effect.Effect<ConnectOutcome>;
  readonly getPassword: () => Effect.Effect<string>;
  readonly getServers: () => Effect.Effect<readonly LiveServer[]>;
  readonly getUsername: () => Effect.Effect<string>;
  readonly isLoggedIn: () => Effect.Effect<boolean>;
  readonly isServerSelectReady: () => Effect.Effect<boolean>;
  readonly isTemporarilyKicked: () => Effect.Effect<boolean>;
  readonly login: (
    username: string,
    password: string,
  ) => Effect.Effect<boolean>;
  readonly logout: () => Effect.Effect<void>;
}

export interface ScriptBankApi {
  /** @param quantity The minimum quantity required. */
  readonly contains: (
    query: ItemQuery,
    /** @defaultValue 1 */
    quantity?: number,
  ) => Effect.Effect<boolean>;
  readonly deposit: (query: ItemQuery) => Effect.Effect<boolean>;
  readonly depositBatch: (
    selectors: readonly ItemQuery[],
  ) => Effect.Effect<boolean[]>;
  readonly get: (query: ItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
  readonly getAvailableSlots: () => Effect.Effect<number>;
  readonly getSlots: () => Effect.Effect<number>;
  readonly getUsedSlots: () => Effect.Effect<number>;
  readonly isOpen: () => Effect.Effect<boolean>;
  /** @param force Whether to reload an already loaded bank. */
  readonly load: (
    /** @defaultValue false */
    force?: boolean,
  ) => Effect.Effect<boolean>;
  readonly open: (
    /** @defaultValue {} */
    options?: BankOpenOptions,
  ) => Effect.Effect<boolean>;
  readonly swap: (
    inventoryQuery: ItemQuery,
    bankQuery: ItemQuery,
  ) => Effect.Effect<boolean>;
  readonly withdraw: (query: ItemQuery) => Effect.Effect<boolean>;
  readonly withdrawBatch: (
    selectors: readonly ItemQuery[],
  ) => Effect.Effect<boolean[]>;
}

export interface ScriptAurasApi {
  readonly get: (
    name: string,
    options?: AuraQueryOptions,
  ) => Effect.Effect<LiveAura | null>;
  readonly getAll: (
    options?: AuraQueryOptions,
  ) => Effect.Effect<readonly LiveAura[]>;
  readonly has: (
    name: string,
    options?: AuraQueryOptions,
  ) => Effect.Effect<boolean>;
}

export interface ScriptCombatMonsterTarget {
  readonly cell: string;
  readonly hp: number;
  readonly level: number;
  readonly maxHp: number;
  readonly monsterId: number;
  readonly monsterMapId: number;
  readonly name: string;
  readonly race: string;
  readonly state: number;
  readonly type: "monster";
}

export interface ScriptCombatPlayerTarget {
  readonly afk: boolean;
  readonly cell: string;
  readonly entityId: number;
  readonly entityType: string;
  readonly hp: number;
  readonly level: number;
  readonly maxHp: number;
  readonly maxMp: number;
  readonly mp: number;
  readonly name: string;
  readonly pad: string;
  readonly sp: number;
  readonly state: number;
  readonly type: "player";
  readonly username: string;
}

export type ScriptCombatTarget =
  | ScriptCombatMonsterTarget
  | ScriptCombatPlayerTarget;

export interface ScriptCombatTargetApi {
  readonly auras: ScriptAurasApi;
  readonly get: () => Effect.Effect<ScriptCombatTarget | null>;
}

export interface ScriptCombatApi {
  readonly attack: (target: MonsterQuery) => Effect.Effect<boolean>;
  readonly cancelAutoAttack: () => Effect.Effect<void>;
  readonly cancelTarget: () => Effect.Effect<void>;
  readonly canUseSkill: (skill: SkillSlot) => Effect.Effect<boolean>;
  readonly exit: () => Effect.Effect<boolean>;
  readonly getSkillCooldownRemainingMs: (
    skill: SkillSlot,
  ) => Effect.Effect<number | null>;
  readonly hunt: (
    query: MonsterQuery,
    options?: HuntOptions,
  ) => Effect.Effect<LiveMonster | null>;
  readonly kill: (
    query: MonsterQuery,
    options?: CombatKillOptions,
  ) => Effect.Effect<boolean>;
  /**
   * @example
   * ```js
   * const script = require("lucent/script");
   * const { Effect, Option, pipe } = require("effect");
   *
   * const result = yield* pipe(
   *   api.combat.killForItem("Boss Name", {
   *     item: "Item Name",
   *     quantity: 10,
   *   }),
   *   Effect.timeoutOption("5 minutes"),
   * );
   *
   * if (Option.isNone(result)) {
   *   yield* script.log("Farming timed out before reaching the quantity.");
   * }
   * ```
   */
  readonly killForItem: (
    target: MonsterQuery,
    goal: FarmItemGoal,
    options?: CombatKillOptions,
  ) => Effect.Effect<boolean>;
  readonly killForTempItem: (
    target: MonsterQuery,
    goal: FarmItemGoal,
    options?: CombatKillOptions,
  ) => Effect.Effect<boolean>;
  readonly target: ScriptCombatTargetApi;
  readonly useSkill: (
    skill: SkillSlot,
    options?: SkillUseOptions,
  ) => Effect.Effect<boolean>;
}

export interface ScriptDropsApi {
  readonly accept: (query: ItemQuery) => Effect.Effect<boolean>;
  readonly contains: (query: ItemQuery) => Effect.Effect<boolean>;
  readonly get: (query: ItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
  readonly reject: (query: ItemQuery) => Effect.Effect<boolean>;
}

/** A detached view of the current Environment configuration. */
export interface EnvironmentSnapshot {
  readonly automation: EnvironmentAutomationOptions;
  readonly questIds: readonly number[];
  readonly questAutoRegister: EnvironmentQuestAutoRegisterOptions;
  readonly questRewards: Readonly<Record<number, number>>;
  readonly itemNames: readonly string[];
  readonly itemNotificationNames: readonly string[];
  readonly dropPolicy: EnvironmentDropPolicy;
  readonly boosts: readonly string[];
}

export interface EnvironmentError extends Error {
  readonly _tag: "EnvironmentError";
}

/** Mutations apply partial updates and return the full resulting snapshot. */
export interface ScriptEnvironmentApi {
  readonly getState: () => Effect.Effect<EnvironmentSnapshot>;
  /** Clears quest, item, and boost registrations. */
  readonly clearRegistrations: () => Effect.Effect<
    EnvironmentSnapshot,
    EnvironmentError
  >;
  readonly setAutomationEnabled: (
    capability: EnvironmentAutomationCapability,
    enabled: boolean,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;

  readonly addQuest: (
    questId: number,
    rewardItemId?: number,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly removeQuest: (
    questId: number,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly setQuestReward: (
    questId: number,
    rewardItemId: number,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly clearQuestReward: (
    questId: number,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly clearQuests: () => Effect.Effect<
    EnvironmentSnapshot,
    EnvironmentError
  >;
  readonly updateQuestAutoRegister: (
    patch: Partial<EnvironmentQuestAutoRegisterOptions>,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;

  readonly addItem: (
    name: string,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly removeItem: (
    name: string,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly clearItems: () => Effect.Effect<
    EnvironmentSnapshot,
    EnvironmentError
  >;
  readonly setItemNotification: (
    name: string,
    enabled: boolean,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  /** Updates one or more drop-handling options. */
  readonly updateDropPolicy: (
    patch: Partial<EnvironmentDropPolicy>,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;

  readonly addBoost: (
    name: string,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly removeBoost: (
    name: string,
  ) => Effect.Effect<EnvironmentSnapshot, EnvironmentError>;
  readonly clearBoosts: () => Effect.Effect<
    EnvironmentSnapshot,
    EnvironmentError
  >;
}

export interface ScriptEventsOn {
  <const T extends ScriptEventType>(
    query: ScriptEventSelectorForType<T>,
    handler: (event: ScriptEventForType<T>) => ScriptCallbackResult,
  ): Effect.Effect<() => void>;
  (
    query: undefined,
    handler: (event: ScriptEvent) => ScriptCallbackResult,
  ): Effect.Effect<() => void>;
  (
    query: ScriptEventSelector | undefined,
    handler: (event: ScriptEvent) => ScriptCallbackResult,
  ): Effect.Effect<() => void>;
}

export interface ScriptWaitForEvent {
  <const T extends ScriptEventType, E = never, R = never>(
    query: ScriptEventSelectorForType<T>,
    options?: TriggeredWaitOptions<E, R>,
  ): Effect.Effect<ScriptEventForType<T> | null, E, Exclude<R, Scope.Scope>>;
  <E = never, R = never>(
    selector?: ScriptEventSelector,
    options?: TriggeredWaitOptions<E, R>,
  ): Effect.Effect<ScriptEvent | null, E, Exclude<R, Scope.Scope>>;
}

export interface ScriptEventsApi {
  /**
   * Runs a handler for every matching event. The handler must return an Effect
   * or generator; plain values and Promises are not supported.
   *
   * Call the returned function to stop listening early.
   * The subscription is also removed automatically when the script stops.
   *
   * @example
   * ```js
   * const script = require("lucent/script");
   *
   * const unsubscribe = yield* api.events.on(
   *   { type: "monster-death" },
   *   function* (event) {
   *     yield* script.log(`Monster ${event.monsterMapId} died.`);
   *   },
   * );
   *
   * yield* script.sleep("30 seconds");
   * unsubscribe();
   * ```
   */
  readonly on: ScriptEventsOn;
  /**
   * Waits for the next matching event. With a `trigger`, starts listening before
   * running that action so an immediate event is not missed.
   *
   * Returns `null` if the trigger returns `false` or the wait times out. The
   * timeout starts after the trigger finishes; omitting it waits indefinitely.
   * Timing out stops the wait but does not undo the action started by the trigger.
   *
   * @example
   * ```js
   * const script = require("lucent/script");
   *
   * const [monster] = yield* api.monsters.getAvailable();
   * if (monster !== undefined) {
   *   const death = yield* api.events.once(
   *     { type: "monster-death", monsterMapId: monster.monsterMapId },
   *     {
   *       trigger: api.combat.attack(monster.monsterMapId),
   *       timeout: "30 seconds",
   *     },
   *   );
   *   yield* api.combat.cancelAutoAttack();
   *
   *   if (death === null) {
   *     yield* script.log("Attack failed or the monster did not die in time.");
   *   }
   * }
   * ```
   */
  readonly once: ScriptWaitForEvent;
}

export interface ScriptHouseApi {
  /** @param quantity The minimum quantity required. */
  readonly contains: (
    query: ItemQuery,
    /** @defaultValue 1 */
    quantity?: number,
  ) => Effect.Effect<boolean>;
  readonly get: (query: ItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
  readonly getAvailableSlots: () => Effect.Effect<number>;
  readonly getSlots: () => Effect.Effect<number>;
  readonly getUsedSlots: () => Effect.Effect<number>;
}

export interface ScriptEquipEnhancementSelector {
  readonly enhancement: string;
  readonly slot?: "cape" | "class" | "helm" | "weapon";
  readonly special?: string;
}

export interface ScriptInventoryApi {
  /** @param quantity The minimum quantity required. */
  readonly contains: (
    query: ItemQuery,
    /** @defaultValue 1 */
    quantity?: number,
  ) => Effect.Effect<boolean>;
  readonly equip: (
    query: ItemQuery,
    options?: EquipOptions,
  ) => Effect.Effect<boolean>;
  readonly equipByEnhancement: (
    query: ScriptEquipEnhancementSelector,
    options?: EquipOptions,
  ) => Effect.Effect<boolean>;
  readonly get: (query: ItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
  readonly getAvailableSlots: (
    /** @defaultValue "bag" */
    pool?: InventoryPool,
  ) => Effect.Effect<number>;
  readonly getSlots: (
    /** @defaultValue "bag" */
    pool?: InventoryPool,
  ) => Effect.Effect<number>;
  readonly getUsedSlots: (
    /** @defaultValue "bag" */
    pool?: InventoryPool,
  ) => Effect.Effect<number>;
  readonly unequipConsumable: (query: ItemQuery) => Effect.Effect<boolean>;
  /** Uses an eligible item directly from inventory, such as a Tonic, Elixir, or boost. */
  readonly use: (query: ItemQuery) => Effect.Effect<boolean>;
  readonly wear: (query: ItemQuery) => Effect.Effect<boolean>;
}

export interface ScriptMapApi {
  readonly getCellPads: () => Effect.Effect<readonly string[]>;
  readonly getCells: () => Effect.Effect<readonly string[]>;
  readonly getId: () => Effect.Effect<number>;
  readonly getMapItem: (itemId: number) => Effect.Effect<void>;
  readonly getName: () => Effect.Effect<string>;
  readonly getRoomNumber: () => Effect.Effect<number>;
  readonly isLoaded: () => Effect.Effect<boolean>;
  readonly loadSwf: (swf: string) => Effect.Effect<void>;
  readonly reload: () => Effect.Effect<void>;
  /** Sets the spawn point, using the current cell or pad when omitted. */
  readonly setSpawnPoint: (
    options?: CellPositionOptions,
  ) => Effect.Effect<void>;
}

export interface ScriptMonstersApi {
  readonly get: (query: MonsterQuery) => Effect.Effect<LiveMonster | null>;
  readonly getAll: () => Effect.Effect<readonly LiveMonster[]>;
  /** Gets monsters in the current cell that are alive and can be targeted for combat. Hidden monsters are included. */
  readonly getAvailable: () => Effect.Effect<readonly LiveMonster[]>;
  /** Checks whether a monster in the current cell is alive and can be targeted for combat. Hidden monsters count as available. */
  readonly isAvailable: (query: MonsterQuery) => Effect.Effect<boolean>;
}

export interface ScriptPacketOn {
  <const D extends PacketDirection>(
    query: PacketSelector & { readonly direction: D },
    handler: (packet: PacketForDirection<D>) => ScriptCallbackResult,
  ): Effect.Effect<() => void>;
  (
    query: PacketSelector | undefined,
    handler: (packet: Packet) => ScriptCallbackResult,
  ): Effect.Effect<() => void>;
}

export interface ScriptWaitForPacket {
  <const D extends PacketDirection, E = never, R = never>(
    query: PacketSelector & { readonly direction: D },
    options?: TriggeredWaitOptions<E, R>,
  ): Effect.Effect<PacketForDirection<D> | null, E, Exclude<R, Scope.Scope>>;
  <E = never, R = never>(
    selector?: PacketSelector,
    options?: TriggeredWaitOptions<E, R>,
  ): Effect.Effect<Packet | null, E, Exclude<R, Scope.Scope>>;
}

export interface ScriptPacketApi {
  readonly on: ScriptPacketOn;
  readonly once: ScriptWaitForPacket;
  /** @param encoding The client packet encoding. */
  readonly sendToClient: (
    packet: string,
    /** @defaultValue "string" */
    encoding?: ClientPacketEncoding,
  ) => Effect.Effect<boolean>;
  /** @param encoding The server packet encoding. */
  readonly sendToServer: (
    packet: string,
    /** @defaultValue "string" */
    encoding?: ServerPacketEncoding,
  ) => Effect.Effect<boolean>;
}

export interface ScriptPlayerFactionsApi {
  readonly get: (query: string | number) => Effect.Effect<LiveFaction | null>;
  readonly getAll: () => Effect.Effect<readonly LiveFaction[]>;
}

export interface ScriptPlayerOutfitsApi {
  /** @param keepColors Whether to preserve the current colors. */
  readonly equip: (
    name: string,
    /** @defaultValue false */
    keepColors?: boolean,
  ) => Effect.Effect<boolean>;
  readonly get: (name: string) => Effect.Effect<LiveOutfit | null>;
  readonly getAll: () => Effect.Effect<readonly LiveOutfit[]>;
  /** @param keepColors Whether to preserve the current colors. */
  readonly wear: (
    name: string,
    /** @defaultValue false */
    keepColors?: boolean,
  ) => Effect.Effect<boolean>;
}

export interface ScriptPlayerApi {
  readonly auras: ScriptAurasApi;
  readonly factions: ScriptPlayerFactionsApi;
  readonly get: () => Effect.Effect<LivePlayer | null>;
  readonly getCell: () => Effect.Effect<string>;
  readonly getClassName: () => Effect.Effect<string>;
  readonly getClassRank: (
    /** @defaultValue equipped inventory class */
    query?: ItemQuery,
  ) => Effect.Effect<number | null>;
  readonly getGender: () => Effect.Effect<string>;
  readonly getGold: () => Effect.Effect<number>;
  readonly getHp: () => Effect.Effect<number>;
  readonly getLevel: () => Effect.Effect<number>;
  readonly getMaxHp: () => Effect.Effect<number>;
  readonly getMaxMp: () => Effect.Effect<number>;
  readonly getMp: () => Effect.Effect<number>;
  readonly getPad: () => Effect.Effect<string>;
  readonly getPosition: () => Effect.Effect<Position>;
  readonly getState: () => Effect.Effect<EntityState>;
  readonly goToPlayer: (name: string) => Effect.Effect<void>;
  readonly hasActiveBoost: (boostType: BoostType) => Effect.Effect<boolean>;
  readonly isAfk: () => Effect.Effect<boolean>;
  readonly isAlive: () => Effect.Effect<boolean>;
  readonly isMember: () => Effect.Effect<boolean>;
  /**
   * Returns whether projections are complete and the account, map, and player are loaded.
   * Use before actions that require a fully loaded player.
   */
  readonly isReady: () => Effect.Effect<boolean>;
  readonly joinMap: (
    target: string,
    options?: CellPositionOptions,
  ) => Effect.Effect<boolean>;
  readonly jumpToCell: (cell: string, pad?: string) => Effect.Effect<boolean>;
  readonly outfits: ScriptPlayerOutfitsApi;
  readonly rest: (
    /** @defaultValue {} */
    options?: RestOptions,
  ) => Effect.Effect<boolean>;
  readonly walkTo: (
    position: Position,
    options?: WalkToOptions,
  ) => Effect.Effect<boolean>;
}

export interface ScriptPlayersApi {
  readonly get: (query: PlayerQuery) => Effect.Effect<LivePlayer | null>;
  readonly getAll: () => Effect.Effect<readonly LivePlayer[]>;
}

export interface ScriptQuestsApi {
  readonly abandon: (questId: number) => Effect.Effect<boolean>;
  /** @param silent Whether to load the quest without opening its UI. */
  readonly accept: (
    questId: number,
    /** @defaultValue false */
    silent?: boolean,
  ) => Effect.Effect<boolean>;
  /** @param silent Whether to load the quests without opening their UI. */
  readonly acceptBatch: (
    questIds: readonly number[],
    /** @defaultValue false */
    silent?: boolean,
  ) => Effect.Effect<boolean[]>;
  readonly canComplete: (questId: number) => Effect.Effect<boolean>;
  readonly complete: (
    questId: number,
    options?: CompleteQuestOptions,
  ) => Effect.Effect<boolean>;
  readonly get: (questId: number) => Effect.Effect<LiveQuest | null>;
  readonly getAccepted: () => Effect.Effect<readonly LiveQuest[]>;
  readonly getAll: () => Effect.Effect<readonly LiveQuest[]>;
  readonly getMaxTurnIns: (questId: number) => Effect.Effect<number>;
  readonly isAvailable: (questId: number) => Effect.Effect<boolean>;
  readonly isInProgress: (questId: number) => Effect.Effect<boolean>;
  /** @param silent Whether to load the quest without opening its UI. */
  readonly load: (
    questId: number,
    /** @defaultValue false */
    silent?: boolean,
  ) => Effect.Effect<boolean>;
  /** @param silent Whether to load the quests without opening their UI. */
  readonly loadBatch: (
    questIds: readonly number[],
    /** @defaultValue false */
    silent?: boolean,
  ) => Effect.Effect<boolean[]>;
}

export interface ScriptEnhanceItemOptions {
  readonly enhancement: string;
  readonly special?: string;
}

/** Controls game render visibility. */
export type ScriptRenderingMode =
  | "full"
  | /** A.k.a. Lag Killer. */ "interface-only"
  | "minimal";

export interface ScriptSettings {
  readonly animations: boolean;
  readonly antiCounter: boolean;
  readonly collisions: boolean;
  /** Local guild override. Null restores the original guild. */
  readonly customGuild: string | null;
  /** Local name override. Null restores the original name. */
  readonly customName: string | null;
  readonly deathAds: boolean;
  readonly enemyMagnet: boolean;
  /** Configured FPS. Minimal rendering uses 2 FPS; app limits may lower it. */
  readonly frameRate: number;
  readonly infiniteRange: boolean;
  /** Hides other players, leaving your own character visible. */
  readonly hidePlayers: boolean;
  readonly provokeCell: boolean;
  readonly renderingMode: ScriptRenderingMode;
  readonly skipCutscenes: boolean;
  readonly walkSpeed: number;
}

/** Only supplied fields are changed. */
export type ScriptSettingsPatch = Partial<ScriptSettings>;

export interface ScriptSettingsApi {
  /**
   * Updates the supplied settings, leaving the rest unchanged.
   *
   * @example
   * ```ts
   * yield* api.settings.update({
   *   animations: false,
   *   hidePlayers: true,
   *   frameRate: 30,
   * });
   * ```
   */
  readonly update: (patch: ScriptSettingsPatch) => Effect.Effect<void>;
  readonly get: () => Effect.Effect<ScriptSettings>;
}

export interface ScriptShopQuantityOptions {
  /**
   * The quantity to buy, validate, or sell.
   * @defaultValue 1
   */
  readonly quantity?: number;
}

export interface ScriptShopApi {
  readonly buy: (
    query: ShopItemQuery,
    options?: ScriptShopQuantityOptions,
  ) => Effect.Effect<boolean>;
  readonly canBuy: (
    query: ShopItemQuery,
    options?: ScriptShopQuantityOptions,
  ) => Effect.Effect<boolean>;
  readonly close: (shopId?: number) => Effect.Effect<boolean>;
  readonly enhanceItem: (
    item: ItemQuery,
    options: ScriptEnhanceItemOptions,
  ) => Effect.Effect<boolean>;
  readonly get: (query: ShopItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
  readonly getCurrent: () => Effect.Effect<LiveShop | null>;
  readonly getMaxBuyQuantity: (query: ShopItemQuery) => Effect.Effect<number>;
  readonly isMergeShop: () => Effect.Effect<boolean>;
  readonly isOpen: (shopId?: number) => Effect.Effect<boolean>;
  readonly open: (shopId: number) => Effect.Effect<boolean>;
  readonly openArmorCustomize: () => Effect.Effect<void>;
  readonly openHairShop: (shopId: number) => Effect.Effect<void>;
  readonly sell: (
    query: ItemQuery,
    options?: ScriptShopQuantityOptions,
  ) => Effect.Effect<boolean>;
}

export interface ScriptTempInventoryApi {
  /** @param quantity The minimum quantity required. */
  readonly contains: (
    query: ItemQuery,
    /** @defaultValue 1 */
    quantity?: number,
  ) => Effect.Effect<boolean>;
  readonly get: (query: ItemQuery) => Effect.Effect<LiveItem | null>;
  readonly getAll: () => Effect.Effect<readonly LiveItem[]>;
}

export interface ScriptWaitApi {
  /** @param options Polling options or a timeout value. */
  readonly forGameAction: (
    action: GameAction,
    /** @defaultValue { interval: "100 millis", timeout: "2 seconds" } */
    options?: WaitOptions | Duration.Input,
  ) => Effect.Effect<boolean>;
  readonly isGameActionAvailable: (
    action: GameAction,
  ) => Effect.Effect<boolean>;
  /** @param options Polling options. */
  readonly until: (
    condition: Effect.Effect<boolean>,
    /** @defaultValue { interval: "100 millis", timeout: undefined } */
    options?: WaitOptions,
  ) => Effect.Effect<boolean>;
  /** @param options Polling options. */
  readonly untilSome: <A>(
    condition: Effect.Effect<Option.Option<A>>,
    /** @defaultValue { interval: "100 millis", timeout: undefined } */
    options?: WaitOptions,
  ) => Effect.Effect<A | null>;
}

/** Controls automatic login recovery. */
export interface ScriptAutoReloginApi {
  readonly getDelayMs: () => Effect.Effect<number>;
  readonly getServer: () => Effect.Effect<string | undefined>;
  readonly getState: () => Effect.Effect<AutoReloginState>;
  readonly isEnabled: () => Effect.Effect<boolean>;
  readonly setDelay: (delay: Duration.Input) => Effect.Effect<AutoReloginState>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<AutoReloginState>;
  readonly setServer: (
    server: string | undefined,
  ) => Effect.Effect<AutoReloginState>;
}

/** Controls automatic movement for supported encounter zones. */
export interface ScriptAutoZoneApi {
  readonly getMap: () => Effect.Effect<AutoZoneSupportedMap | undefined>;
  readonly getState: () => Effect.Effect<AutoZoneState>;
  readonly isEnabled: () => Effect.Effect<boolean>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<AutoZoneState>;
  readonly setMap: (
    map: AutoZoneSupportedMap | undefined,
  ) => Effect.Effect<AutoZoneState>;
}

export type FileSystemOperation =
  | "exists"
  | "list"
  | "read-json"
  | "read-text"
  | "remove"
  | "write-json"
  | "write-text";

/** Why a filesystem action failed. */
export type FileSystemErrorReason =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "not-directory"
  | "directory-not-empty"
  | "too-large"
  | "too-many-entries"
  | "invalid-utf8"
  | "invalid-json"
  | "not-json-serializable"
  | "permission-denied"
  | "busy"
  | "session-closed"
  | "unavailable";

/** Describes a failed filesystem action. */
export interface FileSystemError extends Error {
  readonly _tag: "FileSystemError";
  readonly operation: FileSystemOperation;
  readonly path?: string;
  readonly reason: FileSystemErrorReason;
}

export interface FileSystemErrorConstructor {
  new (fields: {
    readonly operation: FileSystemOperation;
    readonly path?: string;
    readonly reason: FileSystemErrorReason;
  }): FileSystemError;
}

export interface FileSystemEntry {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly name: string;
}

/**
 * Reads and writes files in the shared `Documents/Lucent/data` folder.
 *
 * All scripts use this folder. Paths are relative to it, such as
 * `my-script/settings.json`. Files can be up to 8 MiB, and a folder listing
 * can contain up to 1,000 entries.
 */
export interface ScriptFileSystemApi {
  /** Use with `instanceof` to identify filesystem errors. */
  readonly FileSystemError: FileSystemErrorConstructor;
  /** Checks whether a path exists. */
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
  /** Lists a folder's contents. */
  readonly list: (
    path?: string,
  ) => Effect.Effect<readonly FileSystemEntry[], FileSystemError>;
  /** Reads a JSON file. */
  readonly readJson: (
    path: string,
  ) => Effect.Effect<unknown | undefined, FileSystemError>;
  /** Reads a text file. */
  readonly readText: (
    path: string,
  ) => Effect.Effect<string | undefined, FileSystemError>;
  /** Removes a file or empty folder. */
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
  /** Saves a value as JSON. */
  readonly writeJson: (
    path: string,
    value: unknown,
  ) => Effect.Effect<void, FileSystemError>;
  /** Saves text to a file. */
  readonly writeText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, FileSystemError>;
}

export interface ScriptApi {
  readonly army: ScriptArmyApi;
  readonly auth: ScriptAuthApi;
  readonly bank: ScriptBankApi;
  readonly combat: ScriptCombatApi;
  readonly drops: ScriptDropsApi;
  readonly environment: ScriptEnvironmentApi;
  readonly events: ScriptEventsApi;
  readonly house: ScriptHouseApi;
  readonly inventory: ScriptInventoryApi;
  readonly map: ScriptMapApi;
  readonly monsters: ScriptMonstersApi;
  readonly packet: ScriptPacketApi;
  readonly player: ScriptPlayerApi;
  readonly players: ScriptPlayersApi;
  readonly quests: ScriptQuestsApi;
  readonly settings: ScriptSettingsApi;
  readonly shop: ScriptShopApi;
  readonly tempInventory: ScriptTempInventoryApi;
  readonly wait: ScriptWaitApi;
}

export interface ScriptInputsApi {
  readonly get: (key: string) => Effect.Effect<ScriptInputValue | undefined>;
  readonly getAll: () => Effect.Effect<ScriptInputValues>;
}

export interface ScriptRuntimeOptions {
  readonly restartAfterReconnect: boolean;
  readonly roomPolicy: RoomPolicy;
  readonly safeStartStop: boolean;
}

/** Actions performed when a script exits. */
export interface ScriptExitOptions {
  /** Closes this game client. In a tabbed window, closes only its tab. */
  readonly closeClient?: boolean;
  readonly logout?: boolean;
}

export type ScriptRuntimeOptionsPatch = Partial<ScriptRuntimeOptions>;

export interface ScriptOptionsApi {
  /** Returns a snapshot of the current options. */
  readonly get: () => Effect.Effect<ScriptRuntimeOptions>;
  /** Restores Lucent's built-in defaults, not the options from before the script. */
  readonly reset: () => Effect.Effect<void>;
  /**
   * Updates the supplied options, leaving the rest unchanged.
   *
   * @example
   * ```ts
   * yield* script.options.update({
   *   restartAfterReconnect: true,
   *   roomPolicy: { kind: "specific", roomNumber: 42 },
   * });
   * ```
   */
  readonly update: (
    patch: ScriptRuntimeOptionsPatch,
  ) => Effect.Effect<void, ScriptExecutionError>;
}

export interface ScriptRuntimeApi {
  readonly signal: AbortSignal;
  /** Opens a message dialog and waits until it is dismissed. */
  readonly alert: (message: string) => Effect.Effect<void>;
  /** @param times Number of repetitions. */
  readonly beep: (
    /** @defaultValue 1 */
    times?: number,
  ) => Effect.Effect<void, ScriptExecutionError>;
  /** Opens a confirmation dialog. Canceling the dialog yields `false`. */
  readonly confirm: (message: string) => Effect.Effect<boolean>;
  readonly inputs: ScriptInputsApi;
  readonly options: ScriptOptionsApi;
  /**
   * Exits the current script and prevents later queued scripts from running.
   * Use this as an explicit escape hatch.
   *
   * @param options Exit actions.
   */
  readonly exit: (
    /** @defaultValue { closeClient: false, logout: false } */
    options?: ScriptExitOptions,
  ) => Effect.Effect<never, ScriptStopSignal>;
  readonly log: (...values: unknown[]) => Effect.Effect<void>;
  /**
   * Opens a text prompt with an empty input. Canceling the dialog yields `null`;
   * submitting without entering text yields an empty string, not the placeholder.
   *
   * @param placeholder Hint shown in the empty input. It is not a default value.
   *
   * @example
   * ```js
   * const name = yield* script.prompt("Character name", "Artix");
   * if (name === null) {
   *   yield* script.stop("Prompt canceled.");
   * }
   * if (name === "") {
   *   yield* script.stop("No name entered.");
   * }
   * yield* script.log(name);
   * ```
   */
  readonly prompt: (
    message: string,
    /** @defaultValue "" */
    placeholder?: string,
  ) => Effect.Effect<string | null>;
  readonly sleep: (
    duration: Duration.Input,
  ) => Effect.Effect<void, ScriptExecutionError>;
  /**
   * Stops the current script. If it is part of a queue, the next script runs.
   *
   * @param reason Stop message.
   */
  readonly stop: (
    /** @defaultValue "Script stopped." */
    reason?: string,
  ) => Effect.Effect<never, ScriptStopSignal>;
}

export type ScriptEffectCatch = {
  <Error, Recovered, RecoveryError, RecoveryRequirements>(
    recover: (
      error: Error,
    ) => Effect.Effect<Recovered, RecoveryError, RecoveryRequirements>,
  ): <Value, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<
    Value | Recovered,
    RecoveryError,
    Requirements | RecoveryRequirements
  >;
  <Value, Error, Requirements, Recovered, RecoveryError, RecoveryRequirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    recover: (
      error: Error,
    ) => Effect.Effect<Recovered, RecoveryError, RecoveryRequirements>,
  ): Effect.Effect<
    Value | Recovered,
    RecoveryError,
    Requirements | RecoveryRequirements
  >;
};

export type ScriptEffectFlatMap = {
  <Value, Next, NextError, NextRequirements>(
    next: (value: Value) => Effect.Effect<Next, NextError, NextRequirements>,
  ): <Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Next, Error | NextError, Requirements | NextRequirements>;
  <Value, Error, Requirements, Next, NextError, NextRequirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    next: (value: Value) => Effect.Effect<Next, NextError, NextRequirements>,
  ): Effect.Effect<Next, Error | NextError, Requirements | NextRequirements>;
};

export type ScriptEffectMap = {
  <Value, Next>(
    transform: (value: Value) => Next,
  ): <Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Next, Error, Requirements>;
  <Value, Error, Requirements, Next>(
    effect: Effect.Effect<Value, Error, Requirements>,
    transform: (value: Value) => Next,
  ): Effect.Effect<Next, Error, Requirements>;
};

export type ScriptEffectMapError = {
  <Error, NextError>(
    transform: (error: Error) => NextError,
  ): <Value, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Value, NextError, Requirements>;
  <Value, Error, Requirements, NextError>(
    effect: Effect.Effect<Value, Error, Requirements>,
    transform: (error: Error) => NextError,
  ): Effect.Effect<Value, NextError, Requirements>;
};

export type ScriptEffectTap = {
  <Value, Next, NextError, NextRequirements>(
    inspect: (value: Value) => Effect.Effect<Next, NextError, NextRequirements>,
  ): <Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Value, Error | NextError, Requirements | NextRequirements>;
  <Value, Error, Requirements, Next, NextError, NextRequirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    inspect: (value: Value) => Effect.Effect<Next, NextError, NextRequirements>,
  ): Effect.Effect<Value, Error | NextError, Requirements | NextRequirements>;
};

export type ScriptEffectTimeoutOption = {
  (
    duration: Duration.Input,
  ): <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Option.Option<Value>, Error, Requirements>;
  <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    duration: Duration.Input,
  ): Effect.Effect<Option.Option<Value>, Error, Requirements>;
};

export type ScriptEffectTry = {
  <Value, Error>(options: {
    readonly try: () => Value;
    readonly catch: (error: unknown) => Error;
  }): Effect.Effect<Value, Error>;
};

export type ScriptEffectTryPromise = {
  <Value>(
    evaluate: (signal: AbortSignal) => PromiseLike<Value>,
  ): Effect.Effect<Value, unknown>;
  <Value, Error>(options: {
    readonly try: (signal: AbortSignal) => PromiseLike<Value>;
    readonly catch: (error: unknown) => Error;
  }): Effect.Effect<Value, Error>;
};

type ScriptEffectSuccess<Input> =
  Input extends Effect.Effect<infer Value, infer _Error, infer _Requirements>
    ? Value
    : never;

type ScriptEffectError<Input> =
  Input extends Effect.Effect<infer _Value, infer Error, infer _Requirements>
    ? Error
    : never;

type ScriptEffectRequirements<Input> =
  Input extends Effect.Effect<infer _Value, infer _Error, infer Requirements>
    ? Requirements
    : never;

export type ScriptEffectAllTuple<
  Effects extends readonly Effect.Effect<unknown, unknown, unknown>[],
> = Effect.Effect<
  {
    readonly [Index in keyof Effects]: ScriptEffectSuccess<Effects[Index]>;
  },
  ScriptEffectError<Effects[number]>,
  ScriptEffectRequirements<Effects[number]>
>;

export type ScriptEffectAll = {
  <const Effects extends readonly Effect.Effect<unknown, unknown, unknown>[]>(
    effects: Effects,
  ): ScriptEffectAllTuple<Effects>;
  <Value, Error, Requirements>(
    effects: Iterable<Effect.Effect<Value, Error, Requirements>>,
  ): Effect.Effect<readonly Value[], Error, Requirements>;
};

export type ScriptEffectGen = <
  Yielded extends Effect.Effect<unknown, unknown, unknown>,
  Value,
>(
  body: () => Generator<Yielded, Value, never>,
) => Effect.Effect<
  Value,
  ScriptEffectError<Yielded>,
  ScriptEffectRequirements<Yielded>
>;

export type ScriptEffectRaceFirst = {
  <OtherValue, OtherError, OtherRequirements>(
    other: Effect.Effect<OtherValue, OtherError, OtherRequirements>,
  ): <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<
    Value | OtherValue,
    Error | OtherError,
    Requirements | OtherRequirements
  >;
  <Value, Error, Requirements, OtherValue, OtherError, OtherRequirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
    other: Effect.Effect<OtherValue, OtherError, OtherRequirements>,
  ): Effect.Effect<
    Value | OtherValue,
    Error | OtherError,
    Requirements | OtherRequirements
  >;
};

export interface ScriptEffectModule {
  readonly all: ScriptEffectAll;
  readonly as: <Next>(
    value: Next,
  ) => <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<Next, Error, Requirements>;
  readonly asVoid: <Value, Error, Requirements>(
    effect: Effect.Effect<Value, Error, Requirements>,
  ) => Effect.Effect<void, Error, Requirements>;
  readonly catch: ScriptEffectCatch;
  readonly fail: <Error>(error: Error) => Effect.Effect<never, Error>;
  readonly flatMap: ScriptEffectFlatMap;
  readonly forEach: <Value, Next, Error, Requirements>(
    values: Iterable<Value>,
    transform: (
      value: Value,
      index: number,
    ) => Effect.Effect<Next, Error, Requirements>,
  ) => Effect.Effect<readonly Next[], Error, Requirements>;
  readonly gen: ScriptEffectGen;
  readonly map: ScriptEffectMap;
  readonly mapError: ScriptEffectMapError;
  readonly raceFirst: ScriptEffectRaceFirst;
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>;
  readonly succeed: <Value>(value: Value) => Effect.Effect<Value>;
  readonly sync: <Value>(evaluate: () => Value) => Effect.Effect<Value>;
  readonly tap: ScriptEffectTap;
  readonly timeoutOption: ScriptEffectTimeoutOption;
  readonly try: ScriptEffectTry;
  readonly tryPromise: ScriptEffectTryPromise;
  readonly void: Effect.Effect<void>;
}

export type ScriptOptionGetOrElse = {
  <Fallback>(
    onNone: () => Fallback,
  ): <Value>(option: Option.Option<Value>) => Value | Fallback;
  <Value, Fallback>(
    option: Option.Option<Value>,
    onNone: () => Fallback,
  ): Value | Fallback;
};

export type ScriptOptionMap = {
  <Value, Next>(
    transform: (value: Value) => Next,
  ): (option: Option.Option<Value>) => Option.Option<Next>;
  <Value, Next>(
    option: Option.Option<Value>,
    transform: (value: Value) => Next,
  ): Option.Option<Next>;
};

export type ScriptOptionIsNone = <Value>(
  option: Option.Option<Value>,
) => option is Extract<Option.Option<Value>, { readonly _tag: "None" }>;

export type ScriptOptionIsSome = <Value>(
  option: Option.Option<Value>,
) => option is Extract<Option.Option<Value>, { readonly _tag: "Some" }>;

export type ScriptOptionMatch = {
  <None, Value, Some = None>(options: {
    readonly onNone: () => None;
    readonly onSome: (value: Value) => Some;
  }): (option: Option.Option<Value>) => None | Some;
  <Value, None, Some = None>(
    option: Option.Option<Value>,
    options: {
      readonly onNone: () => None;
      readonly onSome: (value: Value) => Some;
    },
  ): None | Some;
};

export interface ScriptOptionModule {
  readonly getOrElse: ScriptOptionGetOrElse;
  readonly isNone: ScriptOptionIsNone;
  readonly isSome: ScriptOptionIsSome;
  readonly map: ScriptOptionMap;
  readonly match: ScriptOptionMatch;
  readonly none: <Value = never>() => Option.Option<Value>;
  readonly some: <Value>(value: Value) => Option.Option<Value>;
}

export interface ScriptDurationModule {
  readonly days: (days: number) => Duration.Duration;
  readonly hours: (hours: number) => Duration.Duration;
  readonly millis: (millis: number) => Duration.Duration;
  readonly minutes: (minutes: number) => Duration.Duration;
  readonly seconds: (seconds: number) => Duration.Duration;
  readonly toMillis: (duration: Duration.Input) => number;
}

export type ScriptPipe = {
  <A>(value: A): A;
  <A, B>(value: A, ab: (a: A) => B): B;
  <A, B, C>(value: A, ab: (a: A) => B, bc: (b: B) => C): C;
  <A, B, C, D>(value: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  <A, B, C, D, E>(
    value: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
  ): E;
};

export interface ScriptEffectStd {
  readonly Duration: ScriptDurationModule;
  readonly Effect: ScriptEffectModule;
  readonly Option: ScriptOptionModule;
  readonly pipe: ScriptPipe;
}

export type ScriptMain = () => ScriptGenerator<unknown>;

export interface ScriptModuleExports extends ScriptMain {
  readonly inputs?: ScriptInputsDefinition;
}

/** Why a script HTTP request or body read failed. */
export type HttpErrorReason =
  | "request"
  | "redirect"
  | "timeout"
  | "aborted"
  | "too-large"
  | "body";

export interface HttpError extends Error {
  readonly _tag: "HttpError";
  readonly reason: HttpErrorReason;
  readonly url: string;
  readonly cause?: unknown;
}

export interface HttpErrorConstructor {
  new (fields: {
    readonly reason: HttpErrorReason;
    readonly url: string;
    readonly detail: string;
    readonly cause?: unknown;
  }): HttpError;
}

export type HttpRequestBody =
  | string
  | URLSearchParams
  | Uint8Array
  | ArrayBuffer;

export interface HttpRequestOptions {
  /** @defaultValue "GET" */
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: HttpRequestBody;
  /**
   * Total deadline through redirects and the response download.
   * @defaultValue 20 seconds
   */
  readonly timeout?: Duration.Input;
  /** Adds request cancellation alongside script cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Follow redirects, return the redirect response, or fail on a redirect.
   * Cross-origin redirects strip credential headers.
   * @defaultValue "follow"
   */
  readonly redirect?: "follow" | "manual" | "error";
  /** Maximum followed redirects. @defaultValue 5 */
  readonly maxRedirects?: number;
}

/** Fully downloaded response. Each body can be consumed once. */
export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  /** True for status codes 200 through 299. */
  readonly ok: boolean;
  /** Final URL after redirects. */
  readonly url: string;
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  /** Parses JSON locally. Empty or invalid JSON fails. */
  readonly json: () => Effect.Effect<unknown, HttpError>;
  /** Decodes the body as UTF-8. */
  readonly text: () => Effect.Effect<string, HttpError>;
  /** Returns the body bytes. */
  readonly arrayBuffer: () => Effect.Effect<ArrayBuffer, HttpError>;
}

/**
 * Sends HTTP/HTTPS requests.
 */
export interface ScriptHttpApi {
  readonly HttpError: HttpErrorConstructor;
  /**
   * Sends an HTTP request and returns its response. Requests cancel automatically when the script stops.
   *
   * @example
   * ```js
   * const http = require("lucent/http");
   * const script = require("lucent/script");
   *
   * module.exports = function* () {
   *   const response = yield* http.request("https://example.com/events", {
   *     method: "POST",
   *     headers: { "Content-Type": "application/json" },
   *     body: JSON.stringify({ event: "finished" }),
   *     timeout: "15 seconds",
   *   });
   *   if (!response.ok) return yield* script.stop(`HTTP ${response.status}`);
   *   yield* script.log(yield* response.json());
   * };
   * ```
   *
   * @example
   * Continue when an optional request times out.
   * ```js
   * const http = require("lucent/http");
   * const script = require("lucent/script");
   * const { Effect } = require("effect");
   *
   * module.exports = function* () {
   *   yield* Effect.catch(
   *     http.request("https://example.com", { timeout: "5 seconds" }),
   *     (error) => {
   *       if (error instanceof http.HttpError && error.reason === "timeout") {
   *         return script.log("Request timed out. Continuing without the response.");
   *       }
   *       return Effect.fail(error);
   *     },
   *   );
   * };
   * ```
   */
  readonly request: (
    url: string | URL,
    options?: HttpRequestOptions,
  ) => Effect.Effect<HttpResponse, HttpError>;
}
