import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  AuraMutation,
  AuraQueryOptions,
  ItemQuery,
  LiveItem,
  LiveMonster,
  LivePlayer,
  LiveQuest,
  LiveServer,
  LiveShop,
  MonsterData,
  MonsterDrop,
  MonsterQuery,
  PlayerData,
  ShopItemQuery,
} from "@lucent/game";

import type { CombatEntityReference } from "../contract/payload/Combat";

import { makeAuthState } from "./Auth";
import {
  clearItems,
  getItem,
  getItemByCharItemId,
  getItems,
  makeItemsState,
  removeItem,
  replaceItems,
  upsertItem,
  type ItemContainer,
} from "./Items";
import { makeQuestsState } from "./Quests";
import { makeSettingsState, type SettingsState } from "./Settings";
import { makeShopsState } from "./Shops";
import {
  clearArea,
  makeWorldState,
  normalizeUsername,
  putMonster,
  putPlayer,
  type MapState,
} from "./World";
import {
  completeProjection,
  failProjection,
  makeProjectionState,
  resetProjections,
  type ProjectionKey,
} from "./Projection";

export type AuraTarget = CombatEntityReference;

const entityForAura = (
  state: ReturnType<typeof makeWorldState>,
  target: "monster" | "player",
  id: number,
): LiveMonster | LivePlayer | undefined => {
  if (target === "monster") return state.monsters.get(id);
  const username = state.playerIds.get(id);
  return username === undefined ? undefined : state.players.get(username);
};

export const makeStore = Effect.gen(function* () {
  const authRef = yield* SynchronizedRef.make(makeAuthState());
  const itemsRef = yield* SynchronizedRef.make(makeItemsState());
  const projectionRef = yield* SynchronizedRef.make(makeProjectionState());
  const questsRef = yield* SynchronizedRef.make(makeQuestsState());
  const settingsRef = yield* SubscriptionRef.make(makeSettingsState());
  const shopsRef = yield* SynchronizedRef.make(makeShopsState());
  const worldRef = yield* SynchronizedRef.make(makeWorldState());

  const auth = {
    clear: SynchronizedRef.update(authRef, (state) => {
      state.loggedIn = false;
      state.password = "";
      state.username = "";
      state.servers.clear();
      return state;
    }),
    get: SynchronizedRef.get(authRef),
    setCredentials: (username: string, password: string) =>
      SynchronizedRef.update(authRef, (state) => {
        state.username = username;
        state.password = password;
        return state;
      }),
    setLoggedIn: (loggedIn: boolean) =>
      SynchronizedRef.update(authRef, (state) => {
        state.loggedIn = loggedIn;
        return state;
      }),
    setServers: (servers: readonly LiveServer[]) =>
      SynchronizedRef.update(authRef, (state) => {
        const incoming = new Set(servers.map((server) => server.name));
        for (const name of state.servers.keys()) {
          if (!incoming.has(name)) state.servers.delete(name);
        }
        for (const server of servers) {
          const current = state.servers.get(server.name);
          if (current === undefined) state.servers.set(server.name, server);
          else current.replaceFrom(server);
        }
        return state;
      }),
  };

  const items = {
    clear: SynchronizedRef.update(itemsRef, (state) => {
      clearItems(state);
      return state;
    }),
    get: (container: ItemContainer, selector: ItemQuery | ShopItemQuery) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map((state) => getItem(state, container, selector)),
      ),
    getAll: (container: ItemContainer) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map((state) => getItems(state, container)),
      ),
    getByCharItemId: (container: ItemContainer, charItemId: number) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map((state) =>
          getItemByCharItemId(state, container, charItemId),
        ),
      ),
    getHydrationVersion: (container: ItemContainer) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map((state) => state.hydration.get(container) ?? 0),
      ),
    quantity: (container: ItemContainer, selector: ItemQuery) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map(
          (state) => getItem(state, container, selector)?.quantity ?? 0,
        ),
      ),
    remove: (container: ItemContainer, key: number) =>
      SynchronizedRef.modify(itemsRef, (state) => [
        removeItem(state, container, key),
        state,
      ]),
    isHydrated: (container: ItemContainer) =>
      SynchronizedRef.get(itemsRef).pipe(
        Effect.map((state) => (state.hydration.get(container) ?? 0) > 0),
      ),
    replace: (container: ItemContainer, values: readonly LiveItem[]) =>
      SynchronizedRef.update(itemsRef, (state) => {
        replaceItems(state, container, values);
        return state;
      }),
    upsert: (container: ItemContainer, item: LiveItem) =>
      SynchronizedRef.modify(itemsRef, (state) => [
        upsertItem(state, container, item),
        state,
      ]),
  };

  const projection = {
    complete: (key: ProjectionKey) =>
      SynchronizedRef.update(projectionRef, (state) => {
        completeProjection(state, key);
        return state;
      }),
    fail: (key: ProjectionKey, reason: string) =>
      SynchronizedRef.update(projectionRef, (state) => {
        failProjection(state, key, reason);
        return state;
      }),
    get: SynchronizedRef.get(projectionRef).pipe(
      Effect.map((state) => ({
        completed: { ...state.completed },
        epoch: state.epoch,
        failures: { ...state.failures },
      })),
    ),
    reset: SynchronizedRef.update(projectionRef, (state) => {
      resetProjections(state);
      return state;
    }),
  };

  const quests = {
    clear: SynchronizedRef.update(questsRef, (state) => {
      state.accepted.clear();
      state.quests.clear();
      return state;
    }),
    get: (id: number) =>
      SynchronizedRef.get(questsRef).pipe(
        Effect.map((state) => state.quests.get(id) ?? null),
      ),
    getAccepted: SynchronizedRef.get(questsRef).pipe(
      Effect.map((state) =>
        Array.from(state.accepted).flatMap((id) => {
          const quest = state.quests.get(id);
          return quest === undefined ? [] : [quest];
        }),
      ),
    ),
    getAll: SynchronizedRef.get(questsRef).pipe(
      Effect.map((state) => Array.from(state.quests.values())),
    ),
    setAccepted: (ids: readonly number[]) =>
      SynchronizedRef.update(questsRef, (state) => {
        state.accepted.clear();
        for (const id of ids) state.accepted.add(id);
        return state;
      }),
    upsert: (quest: LiveQuest) =>
      SynchronizedRef.update(questsRef, (state) => {
        const current = state.quests.get(quest.id);
        if (current === undefined) state.quests.set(quest.id, quest);
        else current.replaceFrom(quest);
        return state;
      }),
  };

  const settings = {
    changes: SubscriptionRef.changes(settingsRef),
    get: SubscriptionRef.get(settingsRef),
    patch: (patch: Partial<SettingsState>) =>
      SubscriptionRef.updateAndGet(settingsRef, (state) => ({
        ...state,
        ...patch,
      })),
  };

  const shops = {
    clear: SynchronizedRef.update(shopsRef, (state) => {
      state.current = null;
      return state;
    }),
    get: SynchronizedRef.get(shopsRef).pipe(
      Effect.map((state) => state.current),
    ),
    set: (shop: LiveShop | null) =>
      SynchronizedRef.update(shopsRef, (state) => {
        if (
          shop === null ||
          state.current === null ||
          state.current.id !== shop.id
        ) {
          state.current = shop;
        } else {
          state.current.replaceFrom(shop);
        }
        return state;
      }),
  };

  const updateMonster = (
    id: number,
    patch: Partial<MonsterData>,
    writeAuraState: boolean,
  ) =>
    SynchronizedRef.modify(worldRef, (state) => {
      const current = state.monsters.get(id);
      if (current === undefined) return [null, state];
      const wasAlive = current.alive;
      current.update(patch);
      const auraChanges =
        writeAuraState && patch.state !== undefined
          ? current.writeAuraMonsterState(patch.state)
          : [];
      return [
        { auraChanges, becameDead: wasAlive && current.dead, monster: current },
        state,
      ];
    });

  const world = {
    projectAuras: (target: AuraTarget, mutation: AuraMutation, nowMs: number) =>
      SynchronizedRef.modify(worldRef, (state) => [
        entityForAura(state, target.type, target.id)?.projectAuras(
          mutation,
          nowMs,
        ) ?? [],
        state,
      ]),
    clearArea: SynchronizedRef.update(worldRef, (state) => {
      clearArea(state);
      return state;
    }),
    clearSelf: SynchronizedRef.update(worldRef, (state) => {
      state.self = "";
      state.selfEntityId = null;
      return state;
    }),
    getMap: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => ({ ...state.map })),
    ),
    getCellPads: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => [...state.cellPads]),
    ),
    getCells: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => [...state.cells]),
    ),
    getMe: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => state.players.get(state.self) ?? null),
    ),
    getMonster: (selector: MonsterQuery) =>
      SynchronizedRef.get(worldRef).pipe(
        Effect.map(
          (state) =>
            Array.from(state.monsters.values()).find((monster) =>
              monster.matches(selector),
            ) ?? null,
        ),
      ),
    getMonsterDrops: (id: number) =>
      SynchronizedRef.get(worldRef).pipe(
        Effect.map((state) => state.monsterDrops.get(id) ?? null),
      ),
    getMonsterAuras: (id: number, options?: AuraQueryOptions) =>
      SynchronizedRef.get(worldRef).pipe(
        Effect.map((state) =>
          (state.monsters.get(id)?.auras ?? []).filter(
            (aura) => options?.kind === undefined || aura.kind === options.kind,
          ),
        ),
      ),
    getMonsters: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => Array.from(state.monsters.values())),
    ),
    getPlayer: (selector: string | number) =>
      SynchronizedRef.get(worldRef).pipe(
        Effect.map((state) => {
          const key =
            typeof selector === "number"
              ? state.playerIds.get(selector)
              : normalizeUsername(selector);
          return key === undefined ? null : (state.players.get(key) ?? null);
        }),
      ),
    getPlayerAuras: (id: number, options?: AuraQueryOptions) =>
      SynchronizedRef.get(worldRef).pipe(
        Effect.map((state) => {
          const username = state.playerIds.get(id);
          const player =
            username === undefined ? undefined : state.players.get(username);
          return (player?.auras ?? []).filter(
            (aura) => options?.kind === undefined || aura.kind === options.kind,
          );
        }),
      ),
    getSelfEntityId: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => state.selfEntityId),
    ),
    getPlayers: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => Array.from(state.players.values())),
    ),
    putMonster: (monster: LiveMonster) =>
      SynchronizedRef.modify(worldRef, (state) => [
        putMonster(state, monster),
        state,
      ]),
    putPlayer: (player: LivePlayer) =>
      SynchronizedRef.modify(worldRef, (state) => [
        putPlayer(state, player),
        state,
      ]),
    writeMonster: (id: number, patch: Partial<MonsterData>) =>
      updateMonster(id, patch, true),
    patchMonster: (id: number, patch: Partial<MonsterData>) =>
      updateMonster(id, patch, false),
    patchPlayer: (username: string, patch: Partial<PlayerData>) =>
      SynchronizedRef.modify(worldRef, (state) => {
        const current = state.players.get(normalizeUsername(username));
        if (current === undefined) return [null, state];
        const wasAlive = current.alive;
        current.update(patch);
        return [
          { becameDead: wasAlive && current.dead, player: current },
          state,
        ];
      }),
    removePlayer: (username: string) =>
      SynchronizedRef.modify(worldRef, (state) => {
        const key = normalizeUsername(username);
        const current = state.players.get(key) ?? null;
        if (current !== null) {
          state.players.delete(key);
          state.playerIds.delete(current.entityId);
        }
        return [current, state];
      }),
    setMap: (map: MapState) =>
      SynchronizedRef.update(worldRef, (state) => {
        Object.assign(state.map, map);
        return state;
      }),
    setCellPads: (cellPads: readonly string[]) =>
      SynchronizedRef.update(worldRef, (state) => {
        state.cellPads.splice(0, state.cellPads.length, ...cellPads);
        return state;
      }),
    setCells: (cells: readonly string[]) =>
      SynchronizedRef.update(worldRef, (state) => {
        state.cells.splice(0, state.cells.length, ...cells);
        return state;
      }),
    setMonsters: (monsters: readonly LiveMonster[]) =>
      SynchronizedRef.update(worldRef, (state) => {
        state.monsters.clear();
        for (const monster of monsters) putMonster(state, monster);
        return state;
      }),
    setMonsterDrops: (id: number, drops: readonly MonsterDrop[]) =>
      SynchronizedRef.modify(worldRef, (state) => {
        const monster = state.monsters.get(id);
        if (monster === undefined) return [false, state];
        const snapshot = drops.map((drop) => ({
          ...drop,
          item: { ...drop.item },
          questObjectives: [...drop.questObjectives],
          requiredQuestIds: [...drop.requiredQuestIds],
          requiredQuests: [...drop.requiredQuests],
        }));
        state.monsterDrops.set(id, snapshot);
        monster.replaceDrops(snapshot);
        return [true, state];
      }),
    setPlayers: (players: readonly LivePlayer[]) =>
      SynchronizedRef.update(worldRef, (state) => {
        state.players.clear();
        state.playerIds.clear();
        for (const player of players) putPlayer(state, player);
        return state;
      }),
    setSelf: (username: string) =>
      SynchronizedRef.update(worldRef, (state) => {
        state.self = normalizeUsername(username);
        state.selfEntityId = state.players.get(state.self)?.entityId ?? null;
        return state;
      }),
  };

  const snapshot = Effect.all({
    auth: SynchronizedRef.get(authRef).pipe(
      Effect.map((state) => ({
        loggedIn: state.loggedIn,
        password: state.password,
        servers: Object.fromEntries(
          Array.from(state.servers, ([key, server]) => [key, server.toJSON()]),
        ),
        username: state.username,
      })),
    ),
    items: SynchronizedRef.get(itemsRef).pipe(
      Effect.map((state) => ({
        containers: Object.fromEntries(
          Array.from(state.containers, ([container, items]) => [
            container,
            Object.fromEntries(
              Array.from(items, ([key, item]) => [key, item.toJSON()]),
            ),
          ]),
        ),
        hydration: Object.fromEntries(state.hydration),
      })),
    ),
    projection: projection.get,
    quests: SynchronizedRef.get(questsRef).pipe(
      Effect.map((state) => ({
        accepted: Array.from(state.accepted),
        quests: Object.fromEntries(
          Array.from(state.quests, ([key, quest]) => [key, quest.toJSON()]),
        ),
      })),
    ),
    settings: SubscriptionRef.get(settingsRef).pipe(
      Effect.map((state) => ({ ...state })),
    ),
    shops: SynchronizedRef.get(shopsRef).pipe(
      Effect.map((state) => state.current?.toJSON() ?? null),
    ),
    world: SynchronizedRef.get(worldRef).pipe(
      Effect.map((state) => ({
        cellPads: [...state.cellPads],
        cells: [...state.cells],
        map: { ...state.map },
        monsters: Object.fromEntries(
          Array.from(state.monsters, ([id, monster]) => [id, monster.toJSON()]),
        ),
        players: Object.fromEntries(
          Array.from(state.players, ([username, player]) => [
            username,
            player.toJSON(),
          ]),
        ),
        self: state.self,
        selfEntityId: state.selfEntityId,
      })),
    ),
  });

  return {
    auth,
    items,
    projection,
    quests,
    settings,
    shops,
    snapshot,
    world,
  };
});

export type Store = Effect.Success<typeof makeStore>;
export type StoreSnapshot = Effect.Success<Store["snapshot"]>;
