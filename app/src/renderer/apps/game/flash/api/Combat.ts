import { orderMonstersByPriority, toMonsterSelector } from "@lucent/game";
import type { ItemQuery, LiveMonster, MonsterQuery } from "@lucent/game";
import {
  normalizeCombatProfile,
  type CombatProfileDefinition,
  type SkillSlot,
} from "@lucent/core/combatProfiles";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  makeCombatProfileSession,
  type CombatProfileSession,
} from "../../combatProfileSession";
import { makeCombatProfileRuntimeDeps } from "../../combatProfiles";
import type { BridgeService } from "../bridge/Bridge";
import {
  NonNegativeWireInt,
  PositiveWireInt,
  WireInt,
} from "../contract/Coercion";
import { packetData } from "../contract/Packet";
import { decodeCombatActionAcknowledgements } from "../contract/payload/Combat";
import type { Store } from "../state/Store";
import type { AntiCounter } from "./internal/AntiCounter";
import { makeCombatProfileConsumables } from "./internal/CombatProfileConsumables";
import {
  readCombatTarget,
  stopCombat as stopCombatControl,
} from "./internal/CombatControl";
import type { Inventory } from "./Inventory";
import type { Drops } from "./Drops";
import type { Events } from "./Events";
import type { Map } from "./Map";
import type { MonsterLookup } from "./Monsters";
import type { Player } from "./Player";
import type { Players } from "./Players";
import type { Settings } from "./Settings";
import type { TempInventory } from "./TempInventory";
import type { Wait } from "./Wait";

export type { SkillSlot } from "@lucent/core/combatProfiles";

export const CONSUMABLE_CAST_CONFIRMATION_TIMEOUT_MS = 5_000;
export const ConsumableCastDispatchDeadline = Context.Reference<
  number | undefined
>("lucent/game/combat/ConsumableCastDispatchDeadline", {
  defaultValue: () => undefined,
});

export interface HuntOptions {
  /**
   * Whether to prefer the cell containing the most matches.
   * @defaultValue false
   */
  readonly preferMostMatches?: boolean;
}

export interface SkillUseOptions {
  /**
   * Whether to force the skill-use attempt without approaching the target.
   * @defaultValue false
   */
  readonly force?: boolean;
  /** The monster to use the skill on. */
  readonly target?: MonsterQuery;
  /**
   * Whether to wait for the skill to become ready.
   * @defaultValue false
   */
  readonly waitUntilReady?: boolean;
}

export interface CombatKillOptions {
  readonly profile?: CombatProfileDefinition;
  /**
   * Delay between skill attempts.
   * @defaultValue 150
   */
  readonly skillInterval?: Duration.Input;
  /**
   * Skills to cycle while fighting.
   * @defaultValue [1, 2, 3, 4]
   */
  readonly skills?: readonly SkillSlot[];
  readonly targetPriority?: readonly MonsterQuery[];
}

/** Retains local dispatch identity because rejected acknowledgements omit their target. */
export interface ConsumableCastResult {
  readonly actionId: number;
  readonly monsterMapId: number;
  readonly success: boolean;
}

const Consumable = Schema.NullOr(
  Schema.Struct({
    itemId: Schema.optionalKey(WireInt),
    ItemID: Schema.optionalKey(WireInt),
    ready: Schema.optionalKey(Schema.Boolean),
  }),
);
const ConsumableCastDispatch = Schema.NullOr(
  Schema.Struct({
    actionId: NonNegativeWireInt,
    itemId: PositiveWireInt,
    monsterMapId: PositiveWireInt,
  }),
);
const skillIndex = (skill: SkillSlot): SkillSlot | null => {
  return Number.isInteger(skill) && skill >= 0 && skill <= 5 ? skill : null;
};

const DEFAULT_SKILLS: readonly SkillSlot[] = [1, 2, 3, 4];
const normalizeSkills = (
  input: CombatKillOptions["skills"],
): readonly SkillSlot[] => {
  const skills = (input ?? []).filter((skill) => skillIndex(skill) !== null);
  return skills.length === 0 ? DEFAULT_SKILLS : skills;
};

const normalizeSkillInterval = (
  interval: Duration.Input | undefined,
): number => {
  if (interval === undefined) return 150;
  return Option.match(Duration.fromInput(interval), {
    onNone: () => 150,
    onSome: (duration) => {
      const milliseconds = Duration.toMillis(duration);
      return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 150;
    },
  });
};

export const makeCombat = (
  bridge: BridgeService,
  antiCounter: AntiCounter,
  store: Store,
  drops: Drops,
  events: Events,
  inventory: Inventory,
  map: Map,
  monsters: MonsterLookup,
  player: Player,
  players: Players,
  settings: Settings,
  temporary: TempInventory,
  wait: Wait,
) => {
  // Overlap would race AQW's single consumable slot; the deadline also keeps
  // queue delay from producing a late cast.
  const consumableCasts = Semaphore.makeUnsafe(1);
  const targetValue = readCombatTarget(bridge);
  const targetAuras = (options?: { kind?: "active" | "passive" }) =>
    targetValue.pipe(
      Effect.flatMap((target) => {
        if (target === null) return Effect.succeed([]);
        return target.type === "monster"
          ? store.world.getMonsterAuras(target.monsterMapId, options)
          : store.world.getPlayerAuras(target.entityId, options);
      }),
    );

  const getConsumableSkillItem = () =>
    bridge.invoke("combat.getConsumableSkillItem", undefined, Consumable).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (item) => {
            const itemId = item?.itemId ?? item?.ItemID;
            return itemId === undefined
              ? null
              : { itemId, ready: item?.ready === true };
          },
        }),
      ),
    );

  const prepareCombatProfileConsumable = makeCombatProfileConsumables({
    getConsumableSkillItem,
    inventory,
    player,
  }).prepare;

  const getSkillCooldownRemainingMs = (skill: SkillSlot) =>
    bridge.invoke("combat.getSkillCooldownRemaining", [skill], WireInt).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (remaining) => Math.max(0, Math.trunc(remaining)),
        }),
      ),
    );

  const castConsumableOnMonster = (
    selector: MonsterQuery,
    expectedItemId: number,
  ): Effect.Effect<ConsumableCastResult | null> =>
    consumableCasts.withPermit(
      Effect.gen(function* () {
        if (!Number.isInteger(expectedItemId) || expectedItemId <= 0) {
          return null;
        }

        let dispatch:
          | Exclude<typeof ConsumableCastDispatch.Type, null>
          | undefined;
        let confirmation: ConsumableCastResult | null = null;
        const projectedSourceId = yield* store.world.getSelfEntityId;
        const sourceId =
          projectedSourceId ??
          (yield* bridge
            .invoke("player.getUserId", undefined, PositiveWireInt)
            .pipe(Effect.map(Option.getOrNull)));
        if (sourceId === null) return null;

        // The waiter must exist first because AQW can acknowledge in the same
        // frame as dispatch.
        yield* wait.forPacket(
          {
            command: "ct",
            direction: "server",
            predicate: (candidate) => {
              if (dispatch === undefined) return false;
              const expectedActionId = dispatch.actionId;
              const matched = decodeCombatActionAcknowledgements(
                packetData(candidate),
              ).find(
                (candidate) =>
                  candidate.actionId === expectedActionId &&
                  candidate.source.type === "player" &&
                  candidate.source.id === sourceId,
              );
              if (matched === undefined) return false;
              confirmation = {
                actionId: dispatch.actionId,
                monsterMapId: dispatch.monsterMapId,
                success: matched.outcome === 1,
              };
              return true;
            },
            encoding: "json",
          },
          {
            timeout: `${CONSUMABLE_CAST_CONFIRMATION_TIMEOUT_MS} millis`,
            trigger: Effect.gen(function* () {
              const dispatchDeadline = yield* ConsumableCastDispatchDeadline;
              if (
                dispatchDeadline !== undefined &&
                (yield* Clock.currentTimeMillis) > dispatchDeadline
              ) {
                return false;
              }
              const result = yield* bridge
                .invoke(
                  "combat.castConsumableOnMonster",
                  [toMonsterSelector(selector), expectedItemId],
                  ConsumableCastDispatch,
                )
                .pipe(Effect.map(Option.getOrNull));
              if (result === null || result.itemId !== expectedItemId) {
                return false;
              }
              dispatch = result;
              return true;
            }),
          },
        );

        return confirmation;
      }),
    );

  const canUseSkill = (skill: SkillSlot) => {
    const index = skillIndex(skill);
    return index === null
      ? Effect.succeed(false)
      : getSkillCooldownRemainingMs(index).pipe(
          Effect.map((remaining) => remaining === 0),
        );
  };

  const waitForSkillReady = (index: SkillSlot) =>
    wait.until(
      getSkillCooldownRemainingMs(index).pipe(
        Effect.flatMap((remaining) =>
          remaining === null
            ? Effect.succeed(false)
            : remaining > 0
              ? Effect.sleep(remaining).pipe(Effect.as(false))
              : Effect.sleep("150 millis").pipe(
                  Effect.andThen(getSkillCooldownRemainingMs(index)),
                  Effect.map((confirmed) => confirmed === 0),
                ),
        ),
      ),
      { interval: "50 millis", timeout: "5 seconds" },
    );

  const antiCounterActive = (monsterMapId: number) =>
    settings
      .isAntiCounterEnabled()
      .pipe(
        Effect.flatMap((enabled) =>
          enabled ? antiCounter.isActive(monsterMapId) : Effect.succeed(false),
        ),
      );

  const stopCombat = stopCombatControl(bridge);
  const resolveMonsterMapId = (query: MonsterQuery) =>
    monsters
      .getAvailable()
      .pipe(
        Effect.map(
          (available) =>
            available.find((monster) => monster.matches(query))?.monsterMapId,
        ),
      );

  const useSkill = (skill: SkillSlot, options?: SkillUseOptions) => {
    const index = skillIndex(skill);
    if (index === null) return Effect.succeed(false);
    return Effect.gen(function* () {
      const requestedTarget = options?.target;
      if (!(yield* player.isAlive())) return false;
      const selectedTarget =
        requestedTarget === undefined ? yield* targetValue : null;
      const initialMonsterMapId =
        requestedTarget !== undefined
          ? yield* resolveMonsterMapId(requestedTarget)
          : selectedTarget?.type === "monster"
            ? selectedTarget.monsterMapId
            : undefined;
      if (requestedTarget !== undefined && initialMonsterMapId === undefined) {
        return false;
      }
      if (
        initialMonsterMapId !== undefined &&
        (yield* antiCounterActive(initialMonsterMapId))
      ) {
        yield* stopCombat;
        return false;
      }
      const ready =
        options?.waitUntilReady === true
          ? yield* waitForSkillReady(index)
          : yield* canUseSkill(index);
      if (!ready || !(yield* player.isAlive())) return false;
      const selectedTargetBeforeCast =
        requestedTarget === undefined ? yield* targetValue : null;
      const guardedMonsterMapId =
        requestedTarget !== undefined
          ? yield* resolveMonsterMapId(requestedTarget)
          : selectedTargetBeforeCast?.type === "monster"
            ? selectedTargetBeforeCast.monsterMapId
            : selectedTargetBeforeCast === null
              ? initialMonsterMapId
              : undefined;
      if (requestedTarget !== undefined && guardedMonsterMapId === undefined) {
        return false;
      }
      if (
        guardedMonsterMapId !== undefined &&
        (yield* antiCounterActive(guardedMonsterMapId))
      ) {
        if (
          requestedTarget !== undefined ||
          selectedTargetBeforeCast?.type === "monster"
        ) {
          yield* stopCombat;
        }
        return false;
      }
      return yield* bridge
        .invoke(
          "combat.useSkill",
          [
            String(index),
            requestedTarget === undefined || guardedMonsterMapId === undefined
              ? null
              : toMonsterSelector(guardedMonsterMapId),
            options?.force === true,
          ],
          Schema.Boolean,
        )
        .pipe(Effect.map(Option.getOrElse(() => false)));
    });
  };

  const attack = (selector: MonsterQuery) => {
    return Effect.gen(function* () {
      if (!(yield* player.isAlive())) return false;
      const monster = yield* monsters.get(selector);
      if (
        monster !== null &&
        (yield* antiCounterActive(monster.monsterMapId))
      ) {
        yield* stopCombat;
        return false;
      }
      return yield* bridge
        .invoke(
          "combat.attackMonster",
          [toMonsterSelector(selector)],
          Schema.Boolean,
        )
        .pipe(Effect.map(Option.getOrElse(() => false)));
    });
  };

  const reachHuntTarget = (target: LiveMonster | null) => {
    if (target === null || target.cell === "") return Effect.succeed(null);
    return player
      .jumpToCell(target.cell)
      .pipe(Effect.map((reached) => (reached ? target : null)));
  };

  const hunt = (selector: MonsterQuery, options?: HuntOptions) => {
    return monsters.getAll().pipe(
      Effect.flatMap((all) => {
        const matches = all.filter((monster) => monster.matches(selector));
        if (options?.preferMostMatches !== true || matches.length < 2) {
          return reachHuntTarget(matches[0] ?? null);
        }
        const cells = new Map<string, number>();
        for (const monster of matches) {
          cells.set(monster.cell, (cells.get(monster.cell) ?? 0) + 1);
        }
        const target = matches.reduce((best, candidate) =>
          (cells.get(candidate.cell) ?? 0) > (cells.get(best.cell) ?? 0)
            ? candidate
            : best,
        );
        return reachHuntTarget(target);
      }),
    );
  };

  const makeKillProfileRuntime = (
    selector: MonsterQuery,
    options: CombatKillOptions | undefined,
  ) => {
    const definition = options?.profile;
    if (definition === undefined) {
      return Effect.succeed<CombatProfileSession | null>(null);
    }

    const profile = normalizeCombatProfile(definition);
    return Effect.gen(function* () {
      const session = yield* makeCombatProfileSession(
        {
          attack,
          getAvailableMonsters: monsters.getAvailable,
          isAttackBlocked: antiCounterActive,
          isPlayerAlive: player.isAlive,
          onMessage: (handler) =>
            events.on({ type: "update-message" }, (event) =>
              handler({
                message: event.message,
                ...(event.monsterMapId === undefined
                  ? {}
                  : { monsterMapId: event.monsterMapId }),
                source: event.source,
              }),
            ),
          onMonsterDeath: (handler) =>
            events.on({ type: "monster-death" }, (event) =>
              handler(event.monsterMapId),
            ),
          prepare: (sessionProfile) =>
            Effect.gen(function* () {
              const prepared =
                yield* prepareCombatProfileConsumable(sessionProfile);
              return {
                dependencies: makeCombatProfileRuntimeDeps(
                  {
                    canUseSkill,
                    getConsumableSkillItem,
                    target,
                    useSkill,
                  },
                  player,
                  players,
                  prepared.skill5ItemId,
                ),
                release: prepared.release,
                ...(prepared.warning === undefined
                  ? {}
                  : { warning: prepared.warning }),
              };
            }),
        },
        {
          allowTargetFallback: false,
          profile,
          targetPriority: [...(options?.targetPriority ?? []), selector],
        },
      );
      if (session.warning !== undefined) {
        yield* Effect.logWarning({
          message: session.warning,
          profile: profile.label,
        });
      }
      return session;
    });
  };

  const fight = (
    selector: MonsterQuery,
    options: CombatKillOptions | undefined,
    runtime: CombatProfileSession | null,
  ) => {
    const skills = normalizeSkills(options?.skills);
    const skillInterval = normalizeSkillInterval(options?.skillInterval);
    const attackOrder = [...(options?.targetPriority ?? []), selector];

    const selectTarget = Effect.gen(function* () {
      const available = yield* monsters.getAvailable();
      const candidates = orderMonstersByPriority(available, attackOrder);

      for (const candidate of candidates) {
        if (!(yield* antiCounterActive(candidate.monsterMapId)))
          return candidate;
      }

      return null;
    });

    return Effect.forever(
      Effect.gen(function* () {
        if (runtime !== null) {
          const result = yield* runtime.runCycle().pipe(Effect.orDie);
          if (result.kind === "no-target") {
            yield* stopCombat;
          }
          yield* Effect.sleep(result.delayMs);
          return;
        }

        if (!(yield* player.isAlive())) {
          yield* Effect.sleep("250 millis");
          return;
        }

        const target = yield* selectTarget;
        if (target === null) {
          yield* stopCombat;
          yield* Effect.sleep("100 millis");
          return;
        }
        if (!(yield* attack(target.monsterMapId))) {
          yield* Effect.sleep("250 millis");
          return;
        }

        for (const skill of skills) {
          yield* useSkill(skill);
          yield* Effect.sleep(skillInterval);
        }
      }),
    );
  };

  const killWithRuntime = (
    selector: MonsterQuery,
    options: CombatKillOptions | undefined,
    runtime: CombatProfileSession | null,
  ) =>
    Effect.gen(function* () {
      const available = yield* monsters.getAvailable();
      const monster = available.find((candidate) =>
        candidate.matches(selector),
      );
      if (monster === undefined) return false;
      yield* map.setSpawnPoint();

      const death = wait
        .forEvent(
          {
            monsterMapId: monster.monsterMapId,
            type: "monster-death",
          },
          {
            trigger: Effect.forkScoped(fight(selector, options, runtime)).pipe(
              Effect.as(true),
            ),
          },
        )
        .pipe(Effect.map((event) => event !== null));
      const projectedEnd = wait.untilSome(
        store.world
          .getMonster(monster.monsterMapId)
          .pipe(
            Effect.map((current) =>
              current !== monster
                ? Option.some(false)
                : current.dead
                  ? Option.some(true)
                  : Option.none(),
            ),
          ),
        { interval: "250 millis" },
      );
      return yield* Effect.raceFirst(
        death,
        projectedEnd.pipe(Effect.map((dead) => dead === true)),
      );
    });

  const kill = (selector: MonsterQuery, options?: CombatKillOptions) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeKillProfileRuntime(selector, options);
        return yield* killWithRuntime(selector, options, runtime);
      }),
    ).pipe(Effect.ensuring(stopCombat));

  const killFor = (
    selector: MonsterQuery,
    item: ItemQuery,
    requested: number | undefined,
    source: Inventory | TempInventory,
    options?: CombatKillOptions,
  ) => {
    const wanted = Math.max(1, Math.trunc(requested ?? 1));
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeKillProfileRuntime(selector, options);
        const loop = Effect.gen(function* () {
          while (true) {
            if (yield* source.contains(item, wanted)) return true;
            if (yield* drops.contains(item)) {
              yield* drops.accept(item);
              if (yield* source.contains(item, wanted)) return true;
            }
            if (!(yield* killWithRuntime(selector, options, runtime))) {
              yield* Effect.sleep("100 millis");
            }
          }
        });
        return yield* loop;
      }),
    ).pipe(Effect.ensuring(stopCombat));
  };

  const cancelAutoAttack = () =>
    bridge
      .invoke("combat.cancelAutoAttack", undefined, Schema.Void)
      .pipe(Effect.asVoid);

  const cancelTarget = () =>
    bridge
      .invoke("combat.cancelTarget", undefined, Schema.Void)
      .pipe(Effect.asVoid);

  const killForItem = (
    selector: MonsterQuery,
    item: ItemQuery,
    quantity?: number,
    options?: CombatKillOptions,
  ) => killFor(selector, item, quantity, inventory, options);

  const killForTempItem = (
    selector: MonsterQuery,
    item: ItemQuery,
    quantity?: number,
    options?: CombatKillOptions,
  ) => killFor(selector, item, quantity, temporary, options);

  const getTargetAura = (
    name: string,
    options?: { kind?: "active" | "passive" },
  ) =>
    targetAuras(options).pipe(
      Effect.map(
        (auras) =>
          auras.find(
            (aura) =>
              aura.name.localeCompare(name, undefined, {
                sensitivity: "accent",
              }) === 0,
          ) ?? null,
      ),
    );

  const hasTargetAura = (
    name: string,
    options?: { kind?: "active" | "passive" },
  ) => getTargetAura(name, options).pipe(Effect.map((aura) => aura !== null));

  const getTarget = () => targetValue;

  const target = {
    auras: {
      get: getTargetAura,
      getAll: targetAuras,
      has: hasTargetAura,
    },
    get: getTarget,
  };

  return {
    attack,
    cancelAutoAttack,
    cancelTarget,
    canUseSkill,
    castConsumableOnMonster,
    exit: player.exitCombat,
    getConsumableSkillItem,
    getSkillCooldownRemainingMs,
    hunt,
    isAttackBlocked: antiCounterActive,
    kill,
    killForItem,
    killForTempItem,
    prepareCombatProfileConsumable,
    target,
    useSkill,
  };
};

export type Combat = ReturnType<typeof makeCombat>;
