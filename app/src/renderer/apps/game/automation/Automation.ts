import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { FollowerRpcs } from "../../../../shared/gameRendererRpc";
import { Api } from "../flash/api/Api";
import { makeAutoAttack } from "./AutoAttack";
import type { AutoAttackState } from "./AutoAttack";
import { makeAutoRelogin } from "./AutoRelogin";
import type { AutoReloginState } from "./AutoRelogin";
import { makeAutoZone } from "./AutoZone";
import type { AutoZoneState } from "./AutoZone";
import { makeDesktopFollowerPort, makeFollower } from "./Follower";
import type { FollowerState } from "@lucent/core/follower";

export const makeAutomation = Effect.gen(function* () {
  const api = yield* Api;
  const scope = yield* Effect.scope;
  const fibers = yield* FiberMap.make<string>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const autoAttack = yield* makeAutoAttack(api, fibers);
  const autoRelogin = yield* makeAutoRelogin(api, fibers);
  const autoZone = yield* makeAutoZone(api, fibers);
  const follower = yield* makeFollower(api, fibers, makeDesktopFollowerPort());

  const observe = <S>(
    changes: Stream.Stream<S>,
    listener: (state: S) => void,
  ) =>
    changes.pipe(
      Stream.runForEach((state) => Effect.sync(() => listener(state))),
      Effect.forkIn(scope),
      Effect.map((fiber) => () => {
        runFork(Fiber.interrupt(fiber));
      }),
    );

  const observeAutoAttack = (listener: (state: AutoAttackState) => void) =>
    observe(autoAttack.changes, listener);

  const observeAutoRelogin = (listener: (state: AutoReloginState) => void) =>
    observe(autoRelogin.changes, listener);

  const observeAutoZone = (listener: (state: AutoZoneState) => void) =>
    observe(autoZone.changes, listener);

  const observeFollower = (listener: (state: FollowerState) => void) =>
    observe(follower.changes, listener);

  const autoAttackApi = {
    ...autoAttack,
    onState: observeAutoAttack,
  };

  const autoReloginApi = {
    getDelayMs: autoRelogin.getDelayMs,
    getServer: autoRelogin.getServer,
    getState: autoRelogin.getState,
    isEnabled: autoRelogin.isEnabled,
    onState: observeAutoRelogin,
    runLogin: autoRelogin.runLogin,
    setDelay: autoRelogin.setDelay,
    setEnabled: autoRelogin.setEnabled,
    setServer: autoRelogin.setServer,
  };

  const autoZoneApi = {
    getMap: autoZone.getMap,
    getState: autoZone.getState,
    isEnabled: autoZone.isEnabled,
    onState: observeAutoZone,
    setEnabled: autoZone.setEnabled,
    setMap: autoZone.setMap,
  };

  const followerApi = {
    ...follower,
    onState: observeFollower,
  };

  return {
    autoAttack: autoAttackApi,
    autoRelogin: autoReloginApi,
    autoZone: autoZoneApi,
    follower: followerApi,
  };
});

export type AutomationService = Effect.Success<typeof makeAutomation>;

export class Automation extends Context.Service<
  Automation,
  AutomationService
>()("lucent/renderer/automation/Automation") {}

export const layer = Layer.effect(Automation, makeAutomation);

export const followerRpcHandlers = FollowerRpcs.toLayer(
  Effect.gen(function* () {
    const { follower } = yield* Automation;
    return FollowerRpcs.of({
      FollowerConfigure: (config) => follower.configure(config),
      FollowerGetState: () => follower.getState(),
      FollowerMe: () => follower.me(),
      FollowerStart: (config) => follower.startWithSavedProfiles(config),
      FollowerStop: () => follower.stop(),
    });
  }),
);
