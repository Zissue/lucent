import { LiveModel, normalizeGameText } from "./model";
import { LiveAura, reduceActiveAura } from "./aura";
import type {
  Aura,
  AuraDelta,
  AuraKind,
  AuraMutation,
  AuraQueryOptions,
  AuraSnapshot,
} from "./aura";

const percent = (value: number, maximum: number): number =>
  maximum <= 0 ? 0 : (value / maximum) * 100;

export const EntityState = {
  Dead: 0,
  Idle: 1,
  InCombat: 2,
} as const;

export type EntityState = (typeof EntityState)[keyof typeof EntityState];

export const isEntityState = (value: unknown): value is EntityState =>
  value === EntityState.Dead ||
  value === EntityState.Idle ||
  value === EntityState.InCombat;

export interface Entity {
  readonly alive: boolean;
  readonly auras: readonly Aura[];
  readonly cell: string;
  readonly dead: boolean;
  readonly hp: number;
  readonly hpPercent: number;
  readonly idle: boolean;
  readonly inCombat: boolean;
  readonly maxHp: number;
  readonly maxMp: number;
  readonly mp: number;
  readonly mpPercent: number;
  readonly state: EntityState;
  getAura(name: string, options?: AuraQueryOptions): Aura | null;
  hasAura(name: string, options?: AuraQueryOptions): boolean;
  isInCell(cell: string): boolean;
  toJSON(): EntitySnapshot;
}

export interface EntityData {
  cell: string;
  hp: number;
  maxHp: number;
  maxMp: number;
  mp: number;
  state: EntityState;
}

export type EntitySnapshot = Readonly<EntityData> & {
  readonly alive: boolean;
  readonly auras: readonly AuraSnapshot[];
  readonly dead: boolean;
  readonly hpPercent: number;
  readonly idle: boolean;
  readonly inCombat: boolean;
  readonly mpPercent: number;
};

export abstract class LiveEntity<State extends EntityData>
  extends LiveModel<State>
  implements Entity
{
  readonly #auras = new Map<string, LiveAura>();
  #acceptsActiveSync = true;

  get alive(): boolean {
    return this.hp > 0 && this.state !== EntityState.Dead;
  }

  get auras(): readonly LiveAura[] {
    return Array.from(this.#auras.values());
  }

  get cell(): string {
    return this.modelData.cell;
  }

  get dead(): boolean {
    return !this.alive;
  }

  get hp(): number {
    return this.modelData.hp;
  }

  get hpPercent(): number {
    return percent(this.hp, this.maxHp);
  }

  get idle(): boolean {
    return this.state === EntityState.Idle;
  }

  get inCombat(): boolean {
    return this.state === EntityState.InCombat;
  }

  get maxHp(): number {
    return this.modelData.maxHp;
  }

  get maxMp(): number {
    return this.modelData.maxMp;
  }

  get mp(): number {
    return this.modelData.mp;
  }

  get mpPercent(): number {
    return percent(this.mp, this.maxMp);
  }

  get state(): EntityState {
    return this.modelData.state;
  }

  getAura(name: string, options?: AuraQueryOptions): LiveAura | null {
    const normalizedName = normalizeGameText(name);
    for (const aura of this.#auras.values()) {
      if (
        normalizeGameText(aura.name) === normalizedName &&
        (options?.kind === undefined || aura.kind === options.kind)
      ) {
        return aura;
      }
    }
    return null;
  }

  hasAura(name: string, options?: AuraQueryOptions): boolean {
    return this.getAura(name, options) !== null;
  }

  /** @internal */
  projectAuras(mutation: AuraMutation, nowMs: number): readonly AuraDelta[] {
    const changes: AuraDelta[] = [];
    if (
      !this.#acceptsActiveSync &&
      (mutation.type === "apply" ||
        mutation.type === "withdraw" ||
        mutation.type === "set-stack")
    ) {
      return changes;
    }
    switch (mutation.type) {
      case "seed": {
        const entries = new Map(
          mutation.entries.map((entry) => [entry.name, entry]),
        );
        for (const aura of this.#auras.values()) {
          if (aura.kind === "active" && !entries.has(aura.name)) {
            this.commit("active", aura.name, () => undefined, changes);
          }
        }
        for (const entry of entries.values()) {
          this.commit(
            "active",
            entry.name,
            (before) =>
              reduceActiveAura(before, { type: "seed", entry }, nowMs),
            changes,
          );
        }
        break;
      }
      case "apply":
        for (const entry of mutation.entries) {
          this.commit(
            "active",
            entry.name,
            (before) =>
              reduceActiveAura(before, { type: "apply", entry }, nowMs),
            changes,
          );
        }
        break;
      case "withdraw":
        for (const entry of mutation.entries) {
          this.commit(
            "active",
            entry.name,
            (before) => reduceActiveAura(before, entry, nowMs),
            changes,
          );
        }
        break;
      case "set-stack":
        for (const entry of mutation.entries) {
          this.commit(
            "active",
            entry.name,
            (before) =>
              reduceActiveAura(before, { type: "set-stack", ...entry }, nowMs),
            changes,
          );
        }
        break;
      case "passives": {
        const entries = new Map(
          mutation.entries.map((entry) => [entry.name, entry]),
        );
        if (mutation.mode === "replace") {
          for (const aura of this.#auras.values()) {
            if (aura.kind === "passive" && !entries.has(aura.name)) {
              this.commit("passive", aura.name, () => undefined, changes);
            }
          }
        }
        for (const entry of entries.values()) {
          this.commit(
            "passive",
            entry.name,
            () => ({ ...entry, kind: "passive", stack: 1, persistent: false }),
            changes,
          );
        }
        break;
      }
      case "clear":
        for (const aura of this.#auras.values()) {
          if (
            aura.kind === "active" &&
            (!mutation.keepPersistent || !aura.persistent)
          ) {
            this.commit("active", aura.name, () => undefined, changes);
          }
        }
        break;
    }
    return changes;
  }

  /** @internal */
  writeAuraMonsterState(state: EntityState): readonly AuraDelta[] {
    this.#acceptsActiveSync = state !== EntityState.Dead;
    return state === EntityState.InCombat
      ? []
      : this.projectAuras({ type: "clear", keepPersistent: false }, 0);
  }

  private auraKey(kind: AuraKind, name: string): string {
    return `${kind}:${name}`;
  }

  private commit(
    kind: AuraKind,
    name: string,
    edit: (before: AuraSnapshot | undefined) => AuraSnapshot | undefined,
    changes: AuraDelta[],
  ): void {
    const key = this.auraKey(kind, name);
    const current = this.#auras.get(key);
    if (current === undefined) {
      const after = edit(undefined);
      if (after !== undefined) {
        this.#auras.set(key, new LiveAura({ ...after }));
        changes.push({ type: "added", after: { ...after } });
      }
      return;
    }
    const before = current.toJSON();
    const after = edit(before);
    if (after === undefined) {
      this.#auras.delete(key);
      changes.push({ type: "removed", before });
    } else if (
      !Object.entries(before).every(
        ([key, value]) => Reflect.get(after, key) === value,
      ) ||
      !Object.entries(after).every(
        ([key, value]) => Reflect.get(before, key) === value,
      )
    ) {
      current.replaceFrom(new LiveAura({ ...after }));
      changes.push({ type: "updated", before, after: { ...after } });
    }
  }

  isInCell(cell: string): boolean {
    return normalizeGameText(this.cell) === normalizeGameText(cell);
  }

  abstract toJSON(): EntitySnapshot;
}
