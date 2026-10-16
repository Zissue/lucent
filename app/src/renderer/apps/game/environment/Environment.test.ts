import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import {
  createEmptyEnvironmentState,
  type EnvironmentState,
} from "@lucent/core/environment";
import { LiveItem } from "@lucent/game";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import { Api, makeApi, type ApiService } from "../flash/api/Api";
import { Bridge, makeBridge } from "../flash/bridge/Bridge";
import { Gateway, makeGateway } from "../flash/bridge/Gateway";
import { Environment, layer } from "./Environment";

afterEach(() => vi.unstubAllGlobals());

const withEnvironment = Effect.fnUntraced(function* <A, E, R>(
  state: EnvironmentState,
  patchApi: (api: ApiService) => ApiService,
  use: Effect.Effect<A, E, R>,
) {
  vi.stubGlobal("window", {
    desktop: {
      view: "game",
      environment: {
        getState: () => Promise.resolve(state),
        onChanged: () => () => undefined,
      },
    },
    swf: {},
  });
  const bridge = yield* makeBridge();
  const gateway = yield* makeGateway().pipe(
    Effect.provideService(Bridge, bridge),
  );
  const api = yield* makeApi.pipe(
    Effect.provideService(Bridge, bridge),
    Effect.provideService(Gateway, gateway),
  );
  return yield* Effect.gen(function* () {
    yield* Environment;
    return yield* use;
  }).pipe(
    Effect.provide(
      layer.pipe(Layer.provide(Layer.succeed(Api, patchApi(api)))),
    ),
  );
});

const makeCapture = () => {
  const logs: {
    readonly level: string;
    readonly message: unknown;
    readonly cause: Cause.Cause<unknown>;
    readonly data: unknown;
  }[] = [];
  const logger = Logger.make((options) => {
    if (
      !Array.isArray(options.message) ||
      (!options.message.includes("Environment automation failed") &&
        !options.message.includes("Environment automation recovered"))
    ) {
      return;
    }
    logs.push({
      level: options.logLevel,
      message: options.message,
      cause: options.cause,
      data: options.fiber.getRef(References.CurrentLogAnnotations)["data"],
    });
  });
  return { logger, logs };
};

describe("Environment polling logs", () => {
  it.effect(
    "logs three failed quest cycles once and recovers on success",
    () => {
      const { logger, logs } = makeCapture();
      let attempts = 0;
      const initial = createEmptyEnvironmentState();
      return withEnvironment(
        {
          ...initial,
          automation: { ...initial.automation, quests: true },
          questIds: [1],
        },
        (api) => ({
          ...api,
          auth: { ...api.auth, isLoggedIn: () => Effect.succeed(true) },
          quests: {
            ...api.quests,
            getAll: () => Effect.succeed([]),
            isInProgress: () => Effect.succeed(false),
            isAvailable: () => Effect.succeed(false),
            loadBatch: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts <= 3
                  ? Effect.die("quest load failed")
                  : Effect.succeed([true]);
              }),
          },
        }),
        Effect.gen(function* () {
          for (let cycle = 0; cycle < 3; cycle += 1) {
            yield* TestClock.adjust("1 second");
          }
          expect(attempts).toBe(3);
          expect(logs.map(({ level }) => level)).toEqual(["Error"]);
          yield* TestClock.adjust("1 second");
          expect(attempts).toBe(4);
          expect(
            logs.map(({ level, message, data }) => ({ level, message, data })),
          ).toEqual([
            {
              level: "Error",
              message: ["Environment automation failed"],
              data: { key: "environment/quests/load", questIds: [1] },
            },
            {
              level: "Info",
              message: ["Environment automation recovered"],
              data: { key: "environment/quests/load", questIds: [1] },
            },
          ]);
          expect(logs[0]?.cause).toEqual(Cause.die("quest load failed"));
        }),
      ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
    },
  );

  it.effect("does not recover while quest loading returns false", () => {
    const { logger, logs } = makeCapture();
    let loaded = false;
    const initial = createEmptyEnvironmentState();
    return withEnvironment(
      {
        ...initial,
        automation: { ...initial.automation, quests: true },
        questIds: [1],
      },
      (api) => ({
        ...api,
        auth: { ...api.auth, isLoggedIn: () => Effect.succeed(true) },
        quests: {
          ...api.quests,
          getAll: () => Effect.succeed([]),
          isInProgress: () => Effect.succeed(false),
          isAvailable: () => Effect.succeed(false),
          loadBatch: () => Effect.sync(() => [loaded]),
        },
      }),
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds");
        expect(logs.map(({ level }) => level)).toEqual(["Warn"]);
        loaded = true;
        yield* TestClock.adjust("1 second");
        expect(logs.map(({ level }) => level)).toEqual(["Warn", "Info"]);
      }),
    ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });

  it.effect("recovers boosts only after selection and use succeed", () => {
    const { logger, logs } = makeCapture();
    let phase: "lookup" | "active" | "use" | "success" = "lookup";
    const initial = createEmptyEnvironmentState();
    const boost = new LiveItem({
      category: "ServerUse",
      coins: false,
      context: "inventory",
      cost: 0,
      description: "",
      equipped: false,
      equipmentSlot: "",
      file: "",
      houseItem: false,
      itemId: 1,
      link: "xpboost::1",
      memberOnly: false,
      meta: "",
      name: "XP Boost",
      quantity: 1,
      temporaryItem: false,
    });
    return withEnvironment(
      {
        ...initial,
        automation: { ...initial.automation, boosts: true },
        boosts: ["XP Boost"],
      },
      (api) => ({
        ...api,
        auth: { ...api.auth, isLoggedIn: () => Effect.succeed(true) },
        inventory: {
          ...api.inventory,
          get: () =>
            Effect.suspend(() =>
              phase === "lookup"
                ? Effect.die("lookup failed")
                : Effect.succeed(boost),
            ),
          use: () => Effect.sync(() => phase === "success"),
        },
        player: {
          ...api.player,
          hasActiveBoost: () =>
            Effect.suspend(() =>
              phase === "active"
                ? Effect.die("active check failed")
                : Effect.succeed(false),
            ),
        },
      }),
      Effect.gen(function* () {
        yield* TestClock.adjust("5 seconds");
        phase = "active";
        yield* TestClock.adjust("5 seconds");
        phase = "use";
        yield* TestClock.adjust("5 seconds");
        expect(logs.map(({ level }) => level)).toEqual(["Error"]);
        phase = "success";
        yield* TestClock.adjust("5 seconds");
        expect(logs.map(({ level, data }) => ({ level, data }))).toEqual([
          { level: "Error", data: { key: "environment/boosts" } },
          { level: "Info", data: { key: "environment/boosts" } },
        ]);
      }),
    ).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });
});
