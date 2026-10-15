import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type { RoomPolicy } from "@lucent/core/accountSettings";
import type { ApiService } from "../flash/api/Api";
import type { BridgeService } from "../flash/bridge/Bridge";
import {
  applyRoomPolicy,
  roomPolicyAcceptsRoom,
} from "../flash/domain/MapTarget";

const maximumSafeMoveAttempts = 3;
const respawnTimeout = "15 seconds";
const returnInfoPath = "world.returnInfo";

export type SafeStartStopPhase = "after" | "before";

export interface SafeStartStopServices {
  readonly auth: ApiService["auth"];
  readonly bridge: BridgeService;
  readonly combat: ApiService["combat"];
  readonly house: ApiService["house"];
  readonly map: ApiService["map"];
  readonly packet: ApiService["packet"];
  readonly player: ApiService["player"];
  readonly roomPolicy: Effect.Effect<RoomPolicy>;
  readonly wait: ApiService["wait"];
}

class SafeMoveTimeout extends Data.TaggedError("SafeMoveTimeout") {}

export type SafeMoveAttemptResult = "aborted" | "moved" | "retry";
export type SafeMoveResult =
  | Exclude<SafeMoveAttemptResult, "retry">
  | "timed-out";

const safeMoveRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.upTo({ times: maximumSafeMoveAttempts - 1 }),
);

const warnFailure = (phase: SafeStartStopPhase) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logWarning("script safeStartStop safe move failed", cause).pipe(
      Effect.annotateLogs({ component: "scripting", data: { phase } }),
    ),
  );

const abortDisconnected = (phase: SafeStartStopPhase) =>
  Effect.logInfo(
    "script safeStartStop safe move aborted; connection is unavailable",
  ).pipe(Effect.annotateLogs({ component: "scripting", data: { phase } }));

export const retrySafeMove = <R>(
  attempt: Effect.Effect<SafeMoveAttemptResult, never, R>,
): Effect.Effect<SafeMoveResult, never, R> =>
  attempt.pipe(
    Effect.flatMap((result) =>
      result === "retry"
        ? Effect.fail(new SafeMoveTimeout())
        : Effect.succeed<SafeMoveResult>(result),
    ),
    Effect.retry(safeMoveRetrySchedule),
    Effect.catchTag("SafeMoveTimeout", () =>
      Effect.succeed<SafeMoveResult>("timed-out"),
    ),
  );

export const runWithSafeStartStop = <A, E, R, OptionsR, MoveR>(
  main: Effect.Effect<A, E, R>,
  isEnabled: Effect.Effect<boolean, never, OptionsR>,
  moveToSafeDestination: (
    phase: SafeStartStopPhase,
  ) => Effect.Effect<void, never, MoveR>,
): Effect.Effect<A, E, R | OptionsR | MoveR> => {
  const moveIfEnabled = (phase: SafeStartStopPhase) =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled ? moveToSafeDestination(phase) : Effect.void,
      ),
    );

  return Effect.gen(function* () {
    yield* moveIfEnabled("before");
    return yield* main;
  }).pipe(Effect.ensuring(moveIfEnabled("after")));
};

type SafeDestination =
  | { readonly kind: "house" }
  | { readonly kind: "buyhouse"; readonly target: string };

export const makeMoveToSafeDestination = (services: SafeStartStopServices) => {
  const { auth, bridge, combat, house, map, packet, player, roomPolicy, wait } =
    services;

  const isInOwnHouse = bridge
    .invokeJson("flash.callGameFunction0", ["world.isMyHouse"], Schema.Boolean)
    .pipe(Effect.map(Option.getOrElse(() => false)));

  const setReturnInfo = (value: unknown) =>
    bridge
      .invoke("flash.setGameObject", [returnInfoPath, value], Schema.Void)
      .pipe(Effect.map(Option.isSome));

  const moveToSafeDestination = Effect.fn("ScriptRunner.moveToSafeDestination")(
    function* (phase: SafeStartStopPhase) {
      if (!(yield* auth.isLoggedIn())) {
        return yield* abortDisconnected(phase);
      }

      const username = (yield* auth.getUsername()).trim();
      if (username === "") {
        yield* Effect.logWarning(
          "script safeStartStop safe move skipped; username is unavailable",
        ).pipe(
          Effect.annotateLogs({ component: "scripting", data: { phase } }),
        );
        return;
      }

      const hasEquippedHouse = (yield* house.getAll()).some(
        (item) => item.category === "House" && item.equipped,
      );
      let destination: SafeDestination;
      if (hasEquippedHouse) {
        const inOwnHouse = yield* isInOwnHouse;
        if (!(yield* auth.isLoggedIn())) {
          return yield* abortDisconnected(phase);
        }
        if (inOwnHouse) return;
        destination = { kind: "house" };
      } else {
        const policy = yield* roomPolicy;
        const [mapName, currentRoomNumber] = yield* Effect.all([
          map.getName(),
          map.getRoomNumber(),
        ]);
        const inBuyhouse =
          mapName.localeCompare("buyhouse", undefined, {
            sensitivity: "accent",
          }) === 0;
        if (inBuyhouse && roomPolicyAcceptsRoom(policy, currentRoomNumber)) {
          return;
        }
        destination = {
          kind: "buyhouse",
          target: yield* applyRoomPolicy("buyhouse", policy),
        };
      }

      const alive = yield* player.isAlive();
      if (!(yield* auth.isLoggedIn())) {
        return yield* abortDisconnected(phase);
      }
      if (!alive) {
        yield* Effect.logInfo(
          "script safeStartStop safe move waiting for automatic respawn",
        ).pipe(
          Effect.annotateLogs({ component: "scripting", data: { phase } }),
        );
        const respawn = yield* wait.untilSome(
          Effect.all([auth.isLoggedIn(), player.isAlive()]).pipe(
            Effect.map(([loggedIn, alive]) =>
              !loggedIn
                ? Option.some<"aborted" | "ready">("aborted")
                : alive
                  ? Option.some<"aborted" | "ready">("ready")
                  : Option.none(),
            ),
          ),
          { timeout: respawnTimeout },
        );
        if (respawn === "aborted") {
          return yield* abortDisconnected(phase);
        }
        if (respawn !== "ready") {
          yield* Effect.logWarning(
            "script safeStartStop safe move skipped; automatic respawn timed out",
          ).pipe(
            Effect.annotateLogs({ component: "scripting", data: { phase } }),
          );
          return;
        }
      }

      const exitedCombat = yield* combat.exit();
      if (!(yield* auth.isLoggedIn())) {
        return yield* abortDisconnected(phase);
      }
      if (!exitedCombat) {
        yield* Effect.logWarning(
          "script safeStartStop safe move skipped; failed to exit combat",
        ).pipe(
          Effect.annotateLogs({ component: "scripting", data: { phase } }),
        );
        return;
      }

      yield* Effect.sleep("1 second");
      if (!(yield* auth.isLoggedIn())) {
        return yield* abortDisconnected(phase);
      }

      const move = Effect.gen(function* () {
        const result = yield* retrySafeMove(
          destination.kind === "house"
            ? Effect.gen(function* () {
                if (!(yield* auth.isLoggedIn())) return "aborted";
                if (
                  !(yield* packet.sendToServer(`%xt%zm%house%1%${username}%`))
                ) {
                  return "retry";
                }
                const outcome = yield* wait.untilSome(
                  Effect.all([
                    auth.isLoggedIn(),
                    isInOwnHouse,
                    player.isReady(),
                  ]).pipe(
                    Effect.map(([loggedIn, ownHouse, ready]) =>
                      !loggedIn
                        ? Option.some<SafeMoveAttemptResult>("aborted")
                        : ownHouse && ready
                          ? Option.some<SafeMoveAttemptResult>("moved")
                          : Option.none(),
                    ),
                  ),
                  { timeout: "5 seconds" },
                );
                return outcome ?? "retry";
              })
            : Effect.gen(function* () {
                if (!(yield* auth.isLoggedIn())) return "aborted";
                const joined = yield* player.joinMap(destination.target);
                if (!(yield* auth.isLoggedIn())) return "aborted";
                if (!joined) return "retry";
                const outcome = yield* wait.untilSome(
                  Effect.all([auth.isLoggedIn(), player.isReady()]).pipe(
                    Effect.map(([loggedIn, ready]) =>
                      !loggedIn
                        ? Option.some<SafeMoveAttemptResult>("aborted")
                        : ready
                          ? Option.some<SafeMoveAttemptResult>("moved")
                          : Option.none(),
                    ),
                  ),
                  { timeout: "5 seconds" },
                );
                return outcome ?? "retry";
              }),
        );

        if (result === "aborted") {
          yield* abortDisconnected(phase);
        } else if (result === "timed-out") {
          yield* Effect.logWarning(
            "script safeStartStop safe move timed out",
          ).pipe(
            Effect.annotateLogs({
              component: "scripting",
              data: { phase, destination: destination.kind },
            }),
          );
        }
      });

      // Clear (potentially) stale returnInfo for clean transfer.
      const returnInfoIsNull = yield* bridge.invoke(
        "flash.isNull",
        [returnInfoPath],
        Schema.Boolean,
      );
      if (Option.getOrElse(returnInfoIsNull, () => false)) return yield* move;

      const returnInfo = yield* bridge.invokeJson(
        "flash.getGameObject",
        [returnInfoPath],
        Schema.Unknown,
      );
      if (Option.isNone(returnInfo) || !(yield* setReturnInfo(null))) {
        yield* Effect.logWarning(
          "script safeStartStop safe move skipped; world.returnInfo could not be cleared",
        ).pipe(
          Effect.annotateLogs({ component: "scripting", data: { phase } }),
        );
        return;
      }

      yield* move.pipe(
        Effect.ensuring(setReturnInfo(returnInfo.value).pipe(Effect.asVoid)),
      );
    },
  );

  return (phase: SafeStartStopPhase) =>
    moveToSafeDestination(phase).pipe(warnFailure(phase));
};
