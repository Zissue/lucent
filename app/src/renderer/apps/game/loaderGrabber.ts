import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  LoaderGrabberError,
  LoaderGrabberRpcs,
} from "../../../shared/gameRendererRpc";
import type {
  GrabbedData,
  LoaderGrabberGrabRequest,
  LoaderGrabberLoadRequest,
} from "../../../shared/loader-grabber";
import { Api } from "./flash";

const requirePlayerReady = Effect.fn("loaderGrabber.requirePlayerReady")(
  function* () {
    const api = yield* Api;
    if (!(yield* api.player.isReady())) {
      return yield* new LoaderGrabberError({
        detail: "The player is not ready.",
      });
    }
    return api;
  },
);

const loadWithLoaderGrabber = Effect.fn("loaderGrabber.load")(function* (
  request: LoaderGrabberLoadRequest,
) {
  const api = yield* requirePlayerReady();

  switch (request.type) {
    case "armor-customizer":
      yield* api.shops.openArmorCustomize();
      return;
    case "hair-shop":
      yield* api.shops.openHairShop(request.id);
      return;
    case "quest":
      if (!(yield* api.quests.load(request.id))) {
        return yield* new LoaderGrabberError({
          detail: `Quest ${request.id} could not be loaded.`,
        });
      }
      return;
    case "shop":
      if (!(yield* api.shops.load(request.id))) {
        return yield* new LoaderGrabberError({
          detail: `Shop ${request.id} could not be loaded.`,
        });
      }
  }
});

const grabWithLoaderGrabber = Effect.fn("loaderGrabber.grab")(function* (
  request: LoaderGrabberGrabRequest,
): Effect.fn.Return<GrabbedData | null, LoaderGrabberError, Api> {
  const api = yield* requirePlayerReady();

  switch (request.type) {
    case "shop": {
      const shop = yield* api.shops.getCurrent();
      return shop?.toJSON() ?? null;
    }
    case "quest": {
      const quests = yield* api.quests.getAll();
      return quests.map((quest) => quest.toJSON());
    }
    case "inventory": {
      const items = yield* api.inventory.getAll();
      return items.map((item) => item.toJSON());
    }
    case "temp-inventory": {
      const items = yield* api.tempInventory.getAll();
      return items.map((item) => item.toJSON());
    }
    case "bank": {
      const items = yield* api.bank.getAll();
      return items.map((item) => item.toJSON());
    }
    case "cell-monsters": {
      const monsters = yield* api.monsters.getAvailable();
      return monsters.map((monster) => monster.toJSON());
    }
    case "map-monsters": {
      const monsters = yield* api.monsters.getAll();
      return monsters.map((monster) => monster.toJSON());
    }
  }
});

export const loaderGrabberRpcHandlers = LoaderGrabberRpcs.toLayer(
  Effect.gen(function* () {
    const requests = yield* Semaphore.make(1);
    return LoaderGrabberRpcs.of({
      LoaderGrabberGrab: (request) =>
        requests.withPermit(grabWithLoaderGrabber(request)),
      LoaderGrabberLoad: (request) =>
        requests.withPermit(loadWithLoaderGrabber(request)),
    });
  }),
);
