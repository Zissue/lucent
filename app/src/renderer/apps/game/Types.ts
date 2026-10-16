import type { EntityState } from "@lucent/game";

export type ConnectToSelectionFailureReason =
  | "chat-restricted"
  | "email-unconfirmed"
  | "full"
  | "member-only"
  | "offline"
  | "test-client-required"
  | "underage-chat";

export type ConnectToSelectionResult =
  | {
      ok: true;
      status: "selected";
      message: string;
      serverName?: string;
    }
  | {
      ok: false;
      status: "blocked";
      message: string;
      reason: ConnectToSelectionFailureReason;
      serverName?: string;
    }
  | {
      ok: false;
      status: "not-found" | "not-ready";
      message: string;
      serverName?: string;
    };

export type ConsumableSkillItem = {
  itemId: number;
  ready: boolean;
};

export type ConsumableCastDispatch = {
  actionId: number;
  itemId: number;
  monsterMapId: number;
};

export type ObjectSelector<Shape extends Record<string, unknown>> = {
  [Key in keyof Shape]: {
    [SelectedKey in Key]: Shape[SelectedKey];
  } & {
    [OtherKey in Exclude<keyof Shape, Key>]?: never;
  };
}[keyof Shape];

type MonsterSelectorShape = {
  name: string;
  monsterMapId: number;
};

type ItemSelectorShape = {
  name: string;
  itemId: number;
};

export type InventoryItemSelectorShape = ItemSelectorShape;

type ShopItemSelectorShape = ItemSelectorShape & {
  shopItemId: number;
};

export type MonsterSelector = ObjectSelector<MonsterSelectorShape>;

export type InventoryItemSelector = ObjectSelector<InventoryItemSelectorShape>;

export type ShopItemSelector = ObjectSelector<ShopItemSelectorShape>;

export type TargetBaseInfo = {
  type: "monster" | "player";
  hp: number;
  maxHp: number;
  state: EntityState;
  cell: string;
};

export type MonsterTargetInfo = TargetBaseInfo & {
  type: "monster";
  monsterId: number;
  monsterMapId: number;
  level: number;
  race: string;
  name: string;
};

export type PlayerTargetInfo = TargetBaseInfo & {
  type: "player";
  afk: boolean;
  entityId: number;
  entityType: string;
  level: number;
  mp: number;
  maxMp: number;
  sp: number;
  pad: string;
  username: string;
  name: string;
};

export type TargetInfo = MonsterTargetInfo | PlayerTargetInfo;
