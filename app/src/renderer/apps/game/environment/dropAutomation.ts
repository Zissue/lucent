import {
  resolveEnvironmentDropAction,
  type EnvironmentDropItemData,
  type EnvironmentState,
} from "@lucent/core/environment";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface PendingEnvironmentDrop extends EnvironmentDropItemData {
  readonly itemId: number;
}

export interface EnvironmentDropAutomationDependencies {
  readonly accept: (itemId: number) => Effect.Effect<boolean>;
  readonly contains: (itemId: number) => Effect.Effect<boolean>;
  readonly getAll: () => Effect.Effect<readonly PendingEnvironmentDrop[]>;
  readonly getState: () => Effect.Effect<EnvironmentState>;
  readonly reject: (itemId: number) => Effect.Effect<boolean>;
  readonly reportFailure: (
    cause: Cause.Cause<unknown>,
    itemId?: number,
  ) => Effect.Effect<void, unknown>;
}

export interface EnvironmentDropAutomation {
  readonly requestReconciliation: Effect.Effect<void>;
}

class DropRejectionMiss extends Data.TaggedError("DropRejectionMiss")<{
  readonly itemId: number;
}> {}

const rejectionRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 3 }),
);

// Reconcile every pending drop after each wake so a missed UI mutation cannot
// leave older drops stranded when only newer drop events arrive.
export const makeEnvironmentDropAutomation = Effect.fn(
  "Environment.makeDropAutomation",
)(function* (
  dependencies: EnvironmentDropAutomationDependencies,
): Effect.fn.Return<EnvironmentDropAutomation, never, Scope.Scope> {
  const wakeups = yield* Queue.sliding<void>(1);
  const mutationSemaphore = yield* Semaphore.make(1);

  const currentAction = Effect.fn("Environment.currentDropAction")(function* (
    item: PendingEnvironmentDrop,
  ) {
    const state = yield* dependencies.getState();
    if (
      !state.automation.drops ||
      !(yield* dependencies.contains(item.itemId))
    ) {
      return "ignore" as const;
    }
    return resolveEnvironmentDropAction(state, item);
  });

  const tryReject = Effect.fn("Environment.tryRejectDrop")(function* (
    item: PendingEnvironmentDrop,
  ) {
    const action = yield* currentAction(item);
    if (action !== "reject") {
      return;
    }
    if (!(yield* dependencies.reject(item.itemId))) {
      return yield* new DropRejectionMiss({ itemId: item.itemId });
    }
  });

  const rejectWithRetry = (item: PendingEnvironmentDrop) =>
    mutationSemaphore
      .withPermits(1)(tryReject(item))
      .pipe(Effect.retry(rejectionRetrySchedule));

  const reconcileDrop = Effect.fn("Environment.reconcileDrop")(function* (
    item: PendingEnvironmentDrop,
  ) {
    const action = yield* currentAction(item);
    if (action === "ignore") {
      return null;
    }
    if (action === "accept") {
      yield* mutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* currentAction(item)) === "accept") {
            yield* dependencies.accept(item.itemId);
          }
        }),
      );
      return null;
    }

    return yield* rejectWithRetry(item).pipe(
      Effect.as(null),
      Effect.catchTag("DropRejectionMiss", () => Effect.succeed(item.itemId)),
    );
  });

  const runReconciliation = Effect.fn("Environment.runDropReconciliation")(
    function* () {
      const state = yield* dependencies.getState();
      if (
        !state.automation.drops ||
        (state.itemNames.length === 0 &&
          state.itemRules.buckets.length === 0 &&
          !state.itemRules.rejectElse)
      ) {
        return;
      }

      const failures = yield* Effect.forEach(
        yield* dependencies.getAll(),
        (item) =>
          reconcileDrop(item).pipe(
            Effect.catchCause((cause) =>
              dependencies
                .reportFailure(cause, item.itemId)
                .pipe(Effect.as(null)),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const itemIds = failures.filter((itemId) => itemId !== null);
      if (itemIds.length > 0) {
        yield* Effect.logWarning(
          "Environment drop rejection retries exhausted",
        ).pipe(
          Effect.annotateLogs({ component: "environment", data: { itemIds } }),
        );
      }
    },
  );

  yield* Effect.forever(
    Queue.take(wakeups).pipe(
      Effect.andThen(runReconciliation),
      Effect.catchCause((cause) => dependencies.reportFailure(cause)),
    ),
  ).pipe(Effect.forkScoped);

  return {
    requestReconciliation: Queue.offer(wakeups, undefined).pipe(Effect.asVoid),
  };
});
