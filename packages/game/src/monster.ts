import {
  LiveEntity,
  type Entity,
  type EntityData,
  type EntitySnapshot,
} from "./entity";
import type { ItemSnapshot } from "./item";
import { normalizeGameText } from "./model";

/** An item and its acquisition metadata from AQW's monster-drop response. */
export interface MonsterDrop {
  readonly eventDrop: boolean;
  readonly icon: string;
  readonly item: ItemSnapshot;
  readonly questGated: boolean;
  readonly questObjectives: readonly string[];
  /** Numeric rarity identifier returned by AQW. */
  readonly rarity: number;
  /** Display label produced by AQW's rarity lookup. */
  readonly rarityName: string;
  /** Additive boosted drop percentage shown by AQW, when supplied. */
  readonly rateBoostPercent: number | null;
  /** Drop percentage shown by AQW, normalized for variable quantities. */
  readonly ratePercent: number | null;
  /** Quest IDs parsed from AQW's `sReqQuests` field. */
  readonly requiredQuestIds: readonly number[];
  readonly requiredQuests: readonly string[];
  readonly stackSize: number;
  readonly variableQuantity: boolean;
}

export interface MonsterSelectorByMapId {
  readonly monsterMapId: number;
  readonly name?: never;
}

export interface MonsterSelectorByName {
  readonly monsterMapId?: never;
  readonly name: string;
}

export type MonsterSelector = MonsterSelectorByMapId | MonsterSelectorByName;

/**
 * Selects a monster by name, map ID, or selector object.
 *
 * String map IDs require `id` followed by `.`, `:`, `-`, or `'`:
 * `id.123`, `id:123`, `id-123`, or `id'123`.
 */
export type MonsterQuery = MonsterSelector | number | string;

const monsterMapIdToken = /^id[.:'-]([1-9]\d*)$/iu;

export const parseMonsterMapId = (value: string): number | undefined => {
  const match = value.trim().match(monsterMapIdToken);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

export const toMonsterSelector = (query: MonsterQuery): MonsterSelector => {
  if (typeof query === "number") return { monsterMapId: query };
  if (typeof query === "object") {
    return "monsterMapId" in query ? query : { name: query.name.trim() };
  }

  const monsterMapId = parseMonsterMapId(query);
  return monsterMapId === undefined ? { name: query.trim() } : { monsterMapId };
};

export interface Monster extends Entity {
  readonly aggressive: boolean;
  /** Server-provided drops discovered while sharing a cell with this monster. */
  readonly drops: readonly MonsterDrop[];
  readonly level: number;
  readonly monsterId: number;
  readonly monsterMapId: number;
  readonly name: string;
  readonly race: string;
  matches(selector: MonsterQuery): boolean;
}

export const orderMonstersByPriority = (
  monsters: readonly Monster[],
  priorities: readonly MonsterQuery[],
): readonly Monster[] => {
  const ordered: Monster[] = [];
  const selected = new Set<number>();

  for (const priority of priorities) {
    for (const monster of monsters) {
      if (!selected.has(monster.monsterMapId) && monster.matches(priority)) {
        ordered.push(monster);
        selected.add(monster.monsterMapId);
      }
    }
  }

  return ordered;
};

export interface MonsterData extends EntityData {
  aggressive: boolean;
  level: number;
  monsterId: number;
  monsterMapId: number;
  name: string;
  race: string;
}

export type MonsterSnapshot = Readonly<MonsterData> &
  EntitySnapshot & {
    readonly drops: readonly MonsterDrop[];
  };

export class LiveMonster extends LiveEntity<MonsterData> implements Monster {
  readonly #drops = new Map<number, MonsterDrop>();

  get aggressive(): boolean {
    return this.modelData.aggressive;
  }
  get drops(): readonly MonsterDrop[] {
    return Array.from(this.#drops.values());
  }
  get level(): number {
    return this.modelData.level;
  }
  get monsterId(): number {
    return this.modelData.monsterId;
  }
  get monsterMapId(): number {
    return this.modelData.monsterMapId;
  }
  get name(): string {
    return this.modelData.name;
  }
  get race(): string {
    return this.modelData.race;
  }

  matches(selector: MonsterQuery): boolean {
    if (typeof selector === "number") return this.monsterMapId === selector;
    if (typeof selector === "string") {
      const monsterMapId = parseMonsterMapId(selector);
      if (monsterMapId !== undefined) {
        return this.monsterMapId === monsterMapId;
      }
    } else if ("monsterMapId" in selector) {
      return this.monsterMapId === selector.monsterMapId;
    }

    const name = normalizeGameText(
      typeof selector === "string" ? selector : selector.name,
    );
    return (
      name === "*" || (name !== "" && normalizeGameText(this.name) === name)
    );
  }

  /**
   * Replaces the server-provided drop collection without replacing the monster.
   * @internal
   */
  replaceDrops(drops: readonly MonsterDrop[]): void {
    this.#drops.clear();
    for (const drop of drops) {
      this.#drops.set(drop.item.itemId, {
        ...drop,
        item: { ...drop.item },
        questObjectives: [...drop.questObjectives],
        requiredQuestIds: [...drop.requiredQuestIds],
        requiredQuests: [...drop.requiredQuests],
      });
    }
  }

  toJSON(): MonsterSnapshot {
    return {
      ...this.modelData,
      alive: this.alive,
      auras: this.auras.map((aura) => aura.toJSON()),
      dead: this.dead,
      drops: this.drops.map((drop) => ({
        ...drop,
        item: { ...drop.item },
        questObjectives: [...drop.questObjectives],
        requiredQuestIds: [...drop.requiredQuestIds],
        requiredQuests: [...drop.requiredQuests],
      })),
      hpPercent: this.hpPercent,
      idle: this.idle,
      inCombat: this.inCombat,
      mpPercent: this.mpPercent,
    };
  }
}
