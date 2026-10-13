import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Bridge } from "../bridge/Bridge";
import { Gateway } from "../bridge/Gateway";
import { makePipeline } from "../protocol/Pipeline";
import { makeStore } from "../state/Store";
import { makeAuth } from "./Auth";
import { makeAntiCounter } from "./internal/AntiCounter";
import { makeSessionEvents } from "./internal/SessionEvents";
import { makeBank } from "./Bank";
import { makeCombat } from "./Combat";
import { makeDrops } from "./Drops";
import { makeEvents } from "./Events";
import { makeHouse } from "./House";
import { makeInventory } from "./Inventory";
import { makeMap } from "./Map";
import { makeMonsters } from "./Monsters";
import { makePacket } from "./Packet";
import { makePlayer } from "./Player";
import { makePlayers } from "./Players";
import {
  makeProjectionReadiness,
  ProjectionReadiness,
} from "./ProjectionReadiness";
import { makeQuests } from "./Quests";
import { makeSettings } from "./Settings";
import { makeShops } from "./Shops";
import { makeTempInventory } from "./TempInventory";
import { makeWaitApi } from "./Wait";

const makeApiServices = Effect.gen(function* () {
  const bridge = yield* Bridge;
  const gateway = yield* Gateway;
  const store = yield* makeStore;
  const wait = makeWaitApi(bridge, gateway);
  const events = yield* makeEvents(gateway, wait);
  const packet = yield* makePacket(gateway, store, wait);
  const auth = makeAuth(bridge, store, wait);
  const house = makeHouse(bridge, store);
  const inventory = makeInventory(bridge, store, house, wait);
  const bank = yield* makeBank(bridge, store, auth, inventory, house, wait);
  const drops = yield* makeDrops(bridge, store, auth, wait);
  const map = makeMap(bridge, store, wait);
  const monsterServices = yield* makeMonsters(bridge, store, events, wait);
  const monsters = monsterServices.api;
  const players = makePlayers(store);
  const player = makePlayer(bridge, store, auth, inventory, map, wait);
  const sessionEvents = yield* makeSessionEvents(
    wait.until(player.isReady()).pipe(Effect.asVoid),
    gateway.publishEvent,
  );
  const projectionReadiness = makeProjectionReadiness(store);
  const quests = makeQuests(bridge, store, wait);
  const settings = yield* makeSettings(bridge, store);
  const antiCounter = makeAntiCounter(bridge, settings.isAntiCounterEnabled);
  const shops = makeShops(bridge, store, inventory, wait);
  const tempInventory = makeTempInventory(store);
  const debug = typeof window !== "undefined" && window.desktop.debug;
  const traceProjections =
    typeof window !== "undefined" && window.desktop.traceProjections;
  const combat = makeCombat(
    bridge,
    antiCounter,
    store,
    drops,
    events,
    inventory,
    map,
    monsterServices.lookup,
    player,
    players,
    settings,
    tempInventory,
    wait,
  );
  const pipeline = makePipeline(
    store,
    {
      handleEvent: antiCounter.handleEvent,
      handleRuntimeEvent: sessionEvents.handleRuntimeEvent,
      publishEvent: gateway.publishEvent,
      ...(debug ? { reportDiagnostic: gateway.reportDiagnostic } : {}),
      ...(traceProjections
        ? { reportProjectionTrace: gateway.reportProjectionTrace }
        : {}),
    },
    bridge,
  );

  yield* gateway.start(pipeline.packet, pipeline.runtime);

  return {
    api: {
      auth,
      bank,
      combat,
      drops,
      events,
      house,
      inventory,
      map,
      monsterLookup: monsterServices.lookup,
      monsters,
      packet,
      player,
      players,
      quests,
      settings,
      shops,
      tempInventory,
      wait,
    },
    projectionReadiness,
  };
});

export type ApiService = Effect.Success<typeof makeApiServices>["api"];

export const makeApi = makeApiServices.pipe(Effect.map(({ api }) => api));

export class Api extends Context.Service<Api, ApiService>()(
  "lucent/renderer/flash/Api",
) {}

export const layer = Layer.effectContext(
  makeApiServices.pipe(
    Effect.map(({ api, projectionReadiness }) =>
      Context.make(Api, api).pipe(
        Context.add(ProjectionReadiness, projectionReadiness),
      ),
    ),
  ),
);
