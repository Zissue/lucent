import {
  createEmptyEnvironmentState,
  hasEnvironmentItemName,
  normalizeEnvironmentState,
  patchEnvironmentDropPolicy,
  type EnvironmentDropPolicy,
  type EnvironmentItemRules,
  type EnvironmentQuestAutoRegisterOptions,
  type EnvironmentState,
} from "@lucent/core/environment";
import type { Quest } from "@lucent/game";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { selectDesktopBridge } from "../../../../shared/desktopBridge";
import { EnvironmentRpcs } from "../../../../shared/gameRendererRpc";
import { logFailure } from "../../../../shared/logFailure";
import { playBeep } from "../audio/beep";
import { makeFailureTransitions } from "../failureTransitions";
import { Api } from "../flash/api/Api";
import {
  runEnvironmentCycleWhenLoggedIn,
  selectEnvironmentBoost,
  shouldReconcileEnvironmentDrops,
} from "./automation";
import { discoverEnvironmentBoosts, withdrawEnvironmentBoosts } from "./boosts";
import { makeEnvironmentDropAutomation } from "./dropAutomation";
import {
  canRunQuestAction,
  clearQuestActionFailure,
  createQuestAutomationIntent,
  getQuestActionKey,
  getQuestMutationDelayMs,
  QUEST_ACTION_TIMEOUT,
  QUEST_MUTATION_DELAY_MS,
  QUEST_RECONCILE_CONCURRENCY,
  recordQuestActionFailure,
  type QuestActionFailure,
  type QuestAutomationIntent,
} from "./questAutomation";
import {
  getQuestDropTargetNames,
  getRegisteredEnvironmentQuests,
} from "./questDropTargets";

const QUEST_JOB_INTERVAL = "1 second";
const BOOST_JOB_INTERVAL = "5 seconds";

export interface EnvironmentShape {
  getState(): Effect.Effect<EnvironmentState>;
  clear(): Effect.Effect<EnvironmentState, unknown>;
  addQuest(
    questId: number,
    rewardItemId?: number,
  ): Effect.Effect<EnvironmentState, unknown>;
  removeQuest(questId: number): Effect.Effect<EnvironmentState, unknown>;
  setQuestReward(
    questId: number,
    rewardItemId: number,
  ): Effect.Effect<EnvironmentState, unknown>;
  clearQuestReward(questId: number): Effect.Effect<EnvironmentState, unknown>;
  clearQuests(): Effect.Effect<EnvironmentState, unknown>;
  /** Update both quest auto-registration options at once. */
  setQuestAutoRegister(
    options: EnvironmentQuestAutoRegisterOptions,
  ): Effect.Effect<EnvironmentState, unknown>;
  setAutoRegisterRequirements(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setAutoRegisterRewards(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  addItem(name: string): Effect.Effect<EnvironmentState, unknown>;
  removeItem(name: string): Effect.Effect<EnvironmentState, unknown>;
  setAcceptAcMemberOnlyDrops(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setAcceptAcNonMemberDrops(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setAcceptNonAcMemberOnlyDrops(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setAcceptNonAcNonMemberDrops(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setRejectUnregisteredDrops(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setDropPolicy(
    policy: Partial<EnvironmentDropPolicy>,
  ): Effect.Effect<EnvironmentState, unknown>;
  /**
   * Low-level bucket API kept for the Environment renderer.
   *
   * @internal
   */
  setItemRules(
    rules: EnvironmentItemRules,
  ): Effect.Effect<EnvironmentState, unknown>;
  clearItems(): Effect.Effect<EnvironmentState, unknown>;
  addBoost(name: string): Effect.Effect<EnvironmentState, unknown>;
  removeBoost(name: string): Effect.Effect<EnvironmentState, unknown>;
  clearBoosts(): Effect.Effect<EnvironmentState, unknown>;
  fetchBoosts(): Effect.Effect<readonly string[], unknown>;
  setBoostAutomationEnabled(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setDropAutomationEnabled(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setItemNotification(
    name: string,
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  setQuestAutomationEnabled(
    enabled: boolean,
  ): Effect.Effect<EnvironmentState, unknown>;
  syncToAll(): Effect.Effect<EnvironmentState, unknown>;
}

export class Environment extends Context.Service<
  Environment,
  EnvironmentShape
>()("lucent/renderer/game/environment/Environment") {}

const shouldReconcileQuestTargets = (
  previous: EnvironmentState,
  next: EnvironmentState,
): boolean =>
  previous.questAutoRegister.requirements !==
    next.questAutoRegister.requirements ||
  previous.questAutoRegister.rewards !== next.questAutoRegister.rewards ||
  previous.questIds.length !== next.questIds.length ||
  previous.questIds.some((questId, index) => questId !== next.questIds[index]);

const reportDropAutomationFailure = (
  cause: Cause.Cause<unknown>,
  itemId?: number,
) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause)
    : Effect.logError("Environment drop reconciliation failed", cause).pipe(
        Effect.annotateLogs({
          component: "environment",
          data: itemId === undefined ? {} : { itemId },
        }),
      );

export class EnvironmentBridgeError extends Schema.TaggedError<EnvironmentBridgeError>()(
  "EnvironmentBridgeError",
  {
    cause: Schema.Defect(),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const fromDesktop = <A>(label: string, invoke: () => Promise<A>) =>
  Effect.tryPromise({
    try: invoke,
    catch: (cause) =>
      new EnvironmentBridgeError({
        cause,
        detail: label,
      }),
  });

const makeEnvironment = Effect.gen(function* () {
  const api = yield* Api;
  const bridge = selectDesktopBridge(window.desktop, "game").environment;

  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const stateRef = yield* Ref.make<EnvironmentState>(
    createEmptyEnvironmentState(),
  );
  const questActionFailuresRef = yield* Ref.make<
    ReadonlyMap<string, QuestActionFailure>
  >(new Map());
  const inFlightQuestActionKeysRef = yield* SynchronizedRef.make<Set<string>>(
    new Set(),
  );
  const lastQuestMutationAtRef = yield* Ref.make(0);
  const unavailableQuestWarningsRef = yield* Ref.make<ReadonlySet<number>>(
    new Set(),
  );
  const questMutationSemaphore = yield* Semaphore.make(1);
  const automationLogs = yield* makeFailureTransitions({
    component: "environment",
    failed: "Environment automation failed",
    recovered: "Environment automation recovered",
  });

  const getState = () => Ref.get(stateRef);
  const dropAutomation = yield* makeEnvironmentDropAutomation({
    accept: api.drops.accept,
    contains: api.drops.contains,
    getAll: api.drops.getAll,
    getState,
    reject: api.drops.reject,
    reportFailure: reportDropAutomationFailure,
  });

  const reconcilePendingDrops = (): void => {
    runFork(dropAutomation.requestReconciliation);
  };

  const registerQuestDropTargets = (
    state: EnvironmentState,
    quest: Quest,
    options: { readonly reconcileDrops?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      if (
        !state.questAutoRegister.rewards &&
        !state.questAutoRegister.requirements
      ) {
        return;
      }

      const previous = yield* getState();

      for (const itemName of getQuestDropTargetNames(
        quest,
        state.questAutoRegister,
      )) {
        const currentState = yield* getState();
        if (hasEnvironmentItemName(currentState, itemName)) {
          yield* automationLogs.recovered(
            `environment/quests/${quest.id}/drop-target/${itemName}`,
            { itemName, questId: quest.id },
          );
          continue;
        }

        yield* fromDesktop(
          "Failed to auto-register an Environment quest drop target.",
          () => bridge.addItem(itemName),
        ).pipe(
          Effect.tap((next) =>
            Ref.set(stateRef, normalizeEnvironmentState(next)),
          ),
          Effect.tap(() =>
            automationLogs.recovered(
              `environment/quests/${quest.id}/drop-target/${itemName}`,
              { itemName, questId: quest.id },
            ),
          ),
          Effect.catchCause((cause) =>
            automationLogs.failed(
              `environment/quests/${quest.id}/drop-target/${itemName}`,
              cause,
              { itemName, questId: quest.id },
            ),
          ),
        );
      }

      const next = yield* getState();
      if (
        (options.reconcileDrops ?? true) &&
        shouldReconcileEnvironmentDrops(previous, next)
      ) {
        reconcilePendingDrops();
      }
    });

  const registerAllLoadedQuestDropTargets = (state: EnvironmentState) =>
    Effect.gen(function* () {
      if (
        !state.questAutoRegister.rewards &&
        !state.questAutoRegister.requirements
      ) {
        return;
      }

      const quests = getRegisteredEnvironmentQuests(
        yield* api.quests.getAll(),
        state.questIds,
      );
      for (const quest of quests) {
        yield* registerQuestDropTargets(state, quest, {
          reconcileDrops: false,
        }).pipe(
          Effect.tap(() =>
            automationLogs.recovered(
              `environment/quests/${quest.id}/drop-targets`,
              { questId: quest.id },
            ),
          ),
          Effect.catchCause((cause) =>
            automationLogs.failed(
              `environment/quests/${quest.id}/drop-targets`,
              cause,
              { questId: quest.id },
            ),
          ),
        );
      }
    });

  const applyState = (
    incoming: EnvironmentState,
    options: { readonly reconcileDrops?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const previous = yield* Ref.get(stateRef);
      const state = normalizeEnvironmentState(incoming);
      yield* Ref.set(stateRef, state);
      yield* Ref.update(unavailableQuestWarningsRef, (questIds) => {
        const activeQuestIds = new Set(state.questIds);
        return new Set(
          [...questIds].filter((questId) => activeQuestIds.has(questId)),
        );
      });
      if (shouldReconcileQuestTargets(previous, state)) {
        yield* registerAllLoadedQuestDropTargets(state);
      }
      const appliedState = yield* getState();
      if (
        (options.reconcileDrops ?? false) ||
        previous.automation.drops !== appliedState.automation.drops ||
        shouldReconcileEnvironmentDrops(previous, appliedState)
      ) {
        reconcilePendingDrops();
      }
      return appliedState;
    });

  const invokeState = (
    label: string,
    invoke: () => Promise<EnvironmentState>,
  ): Effect.Effect<EnvironmentState, unknown> =>
    fromDesktop(label, invoke).pipe(Effect.flatMap(applyState));

  const clear: EnvironmentShape["clear"] = () =>
    invokeState("Failed to clear Environment state.", bridge.clear);

  const addQuest: EnvironmentShape["addQuest"] = (questId, rewardItemId) =>
    invokeState("Failed to add an Environment quest.", () =>
      bridge.addQuest(questId, rewardItemId),
    );

  const removeQuest: EnvironmentShape["removeQuest"] = (questId) =>
    invokeState("Failed to remove an Environment quest.", () =>
      bridge.removeQuest(questId),
    );

  const setQuestReward: EnvironmentShape["setQuestReward"] = (
    questId,
    rewardItemId,
  ) =>
    invokeState("Failed to set an Environment quest reward.", () =>
      bridge.setQuestReward(questId, rewardItemId),
    );

  const clearQuestReward: EnvironmentShape["clearQuestReward"] = (questId) =>
    invokeState("Failed to clear an Environment quest reward.", () =>
      bridge.clearQuestReward(questId),
    );

  const clearQuests: EnvironmentShape["clearQuests"] = () =>
    invokeState("Failed to clear Environment quests.", bridge.clearQuests);

  const setQuestAutoRegister: EnvironmentShape["setQuestAutoRegister"] = (
    options,
  ) =>
    invokeState("Failed to update Environment quest registration.", () =>
      bridge.setQuestAutoRegister(options),
    );

  const setBoostAutomationEnabled: EnvironmentShape["setBoostAutomationEnabled"] =
    (enabled) =>
      invokeState("Failed to update Environment boost automation.", () =>
        bridge.setAutomationEnabled("boosts", enabled),
      );

  const setDropAutomationEnabled: EnvironmentShape["setDropAutomationEnabled"] =
    (enabled) =>
      invokeState("Failed to update Environment drop automation.", () =>
        bridge.setAutomationEnabled("drops", enabled),
      );

  const setQuestAutomationEnabled: EnvironmentShape["setQuestAutomationEnabled"] =
    (enabled) =>
      invokeState("Failed to update Environment quest automation.", () =>
        bridge.setAutomationEnabled("quests", enabled),
      );

  const setAutoRegisterRequirements: EnvironmentShape["setAutoRegisterRequirements"] =
    (requirements) =>
      getState().pipe(
        Effect.flatMap((state) =>
          setQuestAutoRegister({
            ...state.questAutoRegister,
            requirements,
          }),
        ),
      );

  const setAutoRegisterRewards: EnvironmentShape["setAutoRegisterRewards"] = (
    rewards,
  ) =>
    getState().pipe(
      Effect.flatMap((state) =>
        setQuestAutoRegister({
          ...state.questAutoRegister,
          rewards,
        }),
      ),
    );

  const addItem: EnvironmentShape["addItem"] = (name) =>
    invokeState("Failed to add an Environment item.", () =>
      bridge.addItem(name),
    );

  const removeItem: EnvironmentShape["removeItem"] = (name) =>
    invokeState("Failed to remove an Environment item.", () =>
      bridge.removeItem(name),
    );

  const setItemRules: EnvironmentShape["setItemRules"] = (rules) =>
    invokeState("Failed to update Environment item rules.", () =>
      bridge.setItemRules(rules),
    );

  const setItemNotification: EnvironmentShape["setItemNotification"] = (
    name,
    enabled,
  ) =>
    invokeState("Failed to update Environment item notification.", () =>
      bridge.setItemNotification(name, enabled),
    );

  const setDropPolicy: EnvironmentShape["setDropPolicy"] = (policy) =>
    getState().pipe(
      Effect.flatMap((state) =>
        setItemRules(patchEnvironmentDropPolicy(state.itemRules, policy)),
      ),
    );

  const setAcceptAcMemberOnlyDrops: EnvironmentShape["setAcceptAcMemberOnlyDrops"] =
    (acceptAcMemberOnlyDrops) => setDropPolicy({ acceptAcMemberOnlyDrops });

  const setAcceptAcNonMemberDrops: EnvironmentShape["setAcceptAcNonMemberDrops"] =
    (acceptAcNonMemberDrops) => setDropPolicy({ acceptAcNonMemberDrops });

  const setAcceptNonAcMemberOnlyDrops: EnvironmentShape["setAcceptNonAcMemberOnlyDrops"] =
    (acceptNonAcMemberOnlyDrops) =>
      setDropPolicy({ acceptNonAcMemberOnlyDrops });

  const setAcceptNonAcNonMemberDrops: EnvironmentShape["setAcceptNonAcNonMemberDrops"] =
    (acceptNonAcNonMemberDrops) => setDropPolicy({ acceptNonAcNonMemberDrops });

  const setRejectUnregisteredDrops: EnvironmentShape["setRejectUnregisteredDrops"] =
    (rejectUnregisteredDrops) => setDropPolicy({ rejectUnregisteredDrops });

  const clearItems: EnvironmentShape["clearItems"] = () =>
    invokeState("Failed to clear Environment items.", bridge.clearItems);

  const addBoost: EnvironmentShape["addBoost"] = (name) =>
    invokeState("Failed to add an Environment boost.", () =>
      bridge.addBoost(name),
    );

  const removeBoost: EnvironmentShape["removeBoost"] = (name) =>
    invokeState("Failed to remove an Environment boost.", () =>
      bridge.removeBoost(name),
    );

  const clearBoosts: EnvironmentShape["clearBoosts"] = () =>
    invokeState("Failed to clear Environment boosts.", bridge.clearBoosts);

  const fetchBoosts: EnvironmentShape["fetchBoosts"] = () =>
    api.inventory.getAll().pipe(
      Effect.map((items) =>
        items
          .filter((item) => item.category === "ServerUse")
          .map((item) => item.name),
      ),
      Effect.catchCause((cause) =>
        logFailure("Failed to fetch Environment boosts", cause, {
          failure: "warning",
        }).pipe(
          Effect.annotateLogs({ component: "environment" }),
          Effect.as([]),
        ),
      ),
    );

  const syncToAll: EnvironmentShape["syncToAll"] = () =>
    invokeState(
      "Failed to sync Environment state to all games.",
      bridge.syncToAll,
    );

  const loadRegisteredQuestData = (state: EnvironmentState) =>
    Effect.gen(function* () {
      const quests = yield* api.quests.getAll();
      const loadedIds = new Set(quests.map((quest) => quest.id));
      const unloadedQuestIds = state.questIds.filter(
        (questId) => !loadedIds.has(questId),
      );
      const key = "environment/quests/load";
      const data = { questIds: unloadedQuestIds };
      if (unloadedQuestIds.length === 0) {
        yield* automationLogs.recovered(key, data);
        return;
      }

      yield* api.quests.loadBatch(unloadedQuestIds, true).pipe(
        Effect.timeoutOption(QUEST_ACTION_TIMEOUT),
        Effect.tap((loaded) =>
          Option.isNone(loaded)
            ? automationLogs.failed(
                key,
                Cause.fail(new Cause.TimeoutError()),
                data,
              )
            : loaded.value.every(Boolean)
              ? automationLogs.recovered(key, data)
              : automationLogs.failed(
                  key,
                  Cause.fail(new Error("Registered quests did not load")),
                  data,
                ),
        ),
        Effect.catchCause((cause) =>
          automationLogs
            .failed(key, cause, data)
            .pipe(Effect.as(Option.some([]))),
        ),
      );
    });

  const warnQuestUnavailableOnce = (questId: number) =>
    Effect.gen(function* () {
      const shouldWarn = yield* Ref.modify(
        unavailableQuestWarningsRef,
        (questIds) => {
          if (questIds.has(questId)) {
            return [false, questIds] as const;
          }
          const next = new Set(questIds);
          next.add(questId);
          return [true, next] as const;
        },
      );
      if (shouldWarn) {
        yield* Effect.logWarning(
          "Environment quest is unavailable; skipping accept",
        ).pipe(
          Effect.annotateLogs({ component: "environment", data: { questId } }),
        );
      }
    });

  const clearQuestUnavailableWarning = (questId: number) =>
    Ref.update(unavailableQuestWarningsRef, (questIds) => {
      if (!questIds.has(questId)) {
        return questIds;
      }
      const next = new Set(questIds);
      next.delete(questId);
      return next;
    });

  const determineQuestAutomationIntent = (
    state: EnvironmentState,
    questId: number,
  ) =>
    Effect.gen(function* () {
      const quest = (yield* api.quests.getAll()).find(
        (candidate) => candidate.id === questId,
      );
      if (quest !== undefined) {
        yield* registerQuestDropTargets(state, quest).pipe(
          Effect.tap(() =>
            automationLogs.recovered(
              `environment/quests/${questId}/drop-targets`,
              { questId },
            ),
          ),
          Effect.catchCause((cause) =>
            automationLogs.failed(
              `environment/quests/${questId}/drop-targets`,
              cause,
              { questId },
            ),
          ),
        );
      }

      const inProgress = yield* api.quests.isInProgress(questId);
      const canComplete = inProgress
        ? yield* api.quests.canComplete(questId)
        : false;
      const available = inProgress
        ? false
        : yield* api.quests.isAvailable(questId);

      if (inProgress || available) {
        yield* clearQuestUnavailableWarning(questId);
      } else {
        yield* warnQuestUnavailableOnce(questId);
      }

      const rewardItemId = state.questRewards[questId];
      return createQuestAutomationIntent({
        available,
        canComplete,
        inProgress,
        questId,
        ...(rewardItemId === undefined ? {} : { rewardItemId }),
      });
    }).pipe(
      Effect.tap(() =>
        automationLogs.recovered(`environment/quests/${questId}/reconcile`, {
          questId,
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : automationLogs
              .failed(`environment/quests/${questId}/reconcile`, cause, {
                questId,
              })
              .pipe(Effect.as({ action: "none", questId } as const)),
      ),
    );

  const tryAcquireQuestAction = (key: string) =>
    SynchronizedRef.modify(inFlightQuestActionKeysRef, (keys) => {
      if (keys.has(key)) {
        return [false, keys] as const;
      }
      const next = new Set(keys);
      next.add(key);
      return [true, next] as const;
    });

  const releaseQuestAction = (key: string) =>
    SynchronizedRef.update(inFlightQuestActionKeysRef, (keys) => {
      if (!keys.has(key)) {
        return keys;
      }
      const next = new Set(keys);
      next.delete(key);
      return next;
    });

  const runQuestMutation = (intent: QuestAutomationIntent) => {
    if (intent.action === "none") {
      return Effect.void;
    }
    const key = getQuestActionKey(intent);
    if (key === undefined) {
      return Effect.void;
    }

    return Effect.gen(function* () {
      const failures = yield* Ref.get(questActionFailuresRef);
      if (!canRunQuestAction(failures, key, Date.now())) {
        return;
      }
      if (!(yield* tryAcquireQuestAction(key))) {
        return;
      }

      yield* questMutationSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            if (intent.action === "accept") {
              const available = yield* api.quests.isAvailable(intent.questId);
              if (!available) {
                yield* warnQuestUnavailableOnce(intent.questId);
                return;
              }
              yield* clearQuestUnavailableWarning(intent.questId);
            }

            const now = Date.now();
            const lastMutationAt = yield* Ref.get(lastQuestMutationAtRef);
            const delayMs = getQuestMutationDelayMs(
              lastMutationAt,
              now,
              QUEST_MUTATION_DELAY_MS,
            );
            if (delayMs > 0) {
              yield* Effect.sleep(`${delayMs} millis`);
            }
            yield* Ref.set(lastQuestMutationAtRef, Date.now());

            const mutation =
              intent.action === "accept"
                ? api.quests.accept(intent.questId, true)
                : api.quests.complete(
                    intent.questId,
                    intent.rewardItemId === undefined
                      ? undefined
                      : { rewardItemId: intent.rewardItemId },
                  );
            const jobKey = `environment/quests/mutation/${key}`;
            const data = { action: intent.action, questId: intent.questId };
            const completed = yield* mutation.pipe(
              Effect.timeoutOption(QUEST_ACTION_TIMEOUT),
              Effect.tap((result) =>
                Option.isNone(result)
                  ? automationLogs.failed(
                      jobKey,
                      Cause.fail(new Cause.TimeoutError()),
                      data,
                    )
                  : result.value
                    ? automationLogs.recovered(jobKey, data)
                    : automationLogs.failed(
                        jobKey,
                        Cause.fail(new Error("Quest mutation returned false")),
                        data,
                      ),
              ),
              Effect.map(Option.getOrElse(() => false)),
              Effect.catchCause((cause) =>
                automationLogs
                  .failed(jobKey, cause, data)
                  .pipe(Effect.as(false)),
              ),
            );
            yield* Ref.update(questActionFailuresRef, (current) =>
              completed
                ? clearQuestActionFailure(current, key)
                : recordQuestActionFailure(current, key, Date.now()),
            );
          }),
        )
        .pipe(Effect.ensuring(releaseQuestAction(key)));
    });
  };

  const runQuestAutomation = Effect.gen(function* () {
    const state = yield* getState();
    if (!state.automation.quests || state.questIds.length === 0) {
      return;
    }
    yield* loadRegisteredQuestData(state);
    const intents = yield* Effect.forEach(
      state.questIds,
      (questId) => determineQuestAutomationIntent(state, questId),
      { concurrency: QUEST_RECONCILE_CONCURRENCY },
    );
    for (const intent of intents) {
      yield* runQuestMutation(intent);
    }
    yield* automationLogs.recovered("environment/quests");
  });

  const runBoostAutomation = Effect.gen(function* () {
    const state = yield* getState();
    if (!state.automation.boosts) {
      return;
    }
    let selectionFailed = false;
    const key = "environment/boosts";
    const item = yield* selectEnvironmentBoost(
      state.boosts,
      api.inventory.get,
      api.player.hasActiveBoost,
      (cause) =>
        Effect.sync(() => {
          selectionFailed = true;
        }).pipe(Effect.andThen(automationLogs.failed(key, cause))),
    );
    if (item !== null) {
      const used = yield* api.inventory.use(item.name);
      if (!used) {
        yield* automationLogs.failed(
          key,
          Cause.fail(new Error("Environment boost use returned false")),
          { itemName: item.name },
        );
        return;
      }
    }
    if (!selectionFailed) {
      yield* automationLogs.recovered(key);
    }
  });

  const runAutomationCycle = (
    key: string,
    cycle: Effect.Effect<void, unknown>,
  ) =>
    runEnvironmentCycleWhenLoggedIn(api.auth.isLoggedIn(), cycle).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : automationLogs.failed(key, cause),
      ),
    );

  const startPeriodic = (
    key: string,
    interval: Parameters<typeof Effect.sleep>[0],
    cycle: Effect.Effect<void, unknown>,
  ) =>
    Effect.forever(
      Effect.sleep(interval).pipe(
        Effect.andThen(runAutomationCycle(key, cycle)),
      ),
    ).pipe(Effect.forkScoped);

  yield* startPeriodic(
    "environment/quests",
    QUEST_JOB_INTERVAL,
    runQuestAutomation,
  );
  yield* startPeriodic(
    "environment/boosts",
    BOOST_JOB_INTERVAL,
    runBoostAutomation,
  );

  const removeStateListener = bridge.onChanged((state) => {
    runFork(
      applyState(state).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            "Failed to apply changed Environment state",
            cause,
          ).pipe(Effect.annotateLogs({ component: "environment" })),
        ),
      ),
    );
  });
  const removeDropListener = yield* api.events.on(
    { type: "item-drop" },
    (event) =>
      Effect.gen(function* () {
        const state = yield* getState();
        if (
          state.automation.drops &&
          hasEnvironmentItemName(
            { itemNames: state.itemNotificationNames },
            event.item.name,
          )
        ) {
          yield* Effect.sync(() => playBeep(1));
        }

        yield* dropAutomation.requestReconciliation;
      }).pipe(
        Effect.catchCause((cause) =>
          reportDropAutomationFailure(cause, event.item.itemId),
        ),
      ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      removeStateListener();
      removeDropListener();
    }),
  );

  const initialState = yield* fromDesktop(
    "Failed to load Environment state.",
    bridge.getState,
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Failed to load Environment state", cause).pipe(
        Effect.annotateLogs({ component: "environment" }),
        Effect.as(createEmptyEnvironmentState()),
      ),
    ),
  );
  yield* applyState(initialState, { reconcileDrops: true });

  return Environment.of({
    addBoost,
    addItem,
    addQuest,
    clear,
    clearBoosts,
    clearItems,
    clearQuestReward,
    clearQuests,
    fetchBoosts,
    getState,
    removeBoost,
    removeItem,
    removeQuest,
    setAcceptAcMemberOnlyDrops,
    setAcceptAcNonMemberDrops,
    setAcceptNonAcMemberOnlyDrops,
    setAcceptNonAcNonMemberDrops,
    setAutoRegisterRequirements,
    setAutoRegisterRewards,
    setBoostAutomationEnabled,
    setDropAutomationEnabled,
    setDropPolicy,
    setItemRules,
    setItemNotification,
    setQuestAutoRegister,
    setQuestAutomationEnabled,
    setQuestReward,
    setRejectUnregisteredDrops,
    syncToAll,
  });
});

export const layer = Layer.effect(Environment, makeEnvironment);

export const environmentRpcHandlers = EnvironmentRpcs.toLayer(
  Effect.gen(function* () {
    const api = yield* Api;
    return EnvironmentRpcs.of({
      EnvironmentFetchBoosts: () => discoverEnvironmentBoosts(api),
      EnvironmentWithdrawBoosts: ({ itemIds }) =>
        withdrawEnvironmentBoosts(api, itemIds),
    });
  }),
);
