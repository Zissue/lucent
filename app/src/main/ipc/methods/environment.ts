import {
  addEnvironmentBoost,
  addEnvironmentBoosts,
  addEnvironmentItem,
  addEnvironmentItems,
  addEnvironmentQuest,
  addEnvironmentQuests,
  clearEnvironmentBoosts,
  clearEnvironmentItems,
  clearEnvironmentQuestReward,
  clearEnvironmentQuests,
  clearEnvironmentState,
  removeEnvironmentBoost,
  removeEnvironmentItem,
  removeEnvironmentQuest,
  setEnvironmentAutomationEnabled,
  setEnvironmentItemNotification,
  setEnvironmentItemRules,
  setEnvironmentQuestAutoRegisterOptions,
  setEnvironmentQuestReward,
  type EnvironmentState,
} from "@lucent/core/environment";
import * as Effect from "effect/Effect";

import { EnvironmentIpc } from "../../../shared/ipc";
import { GameEnvironments } from "../../internal/environment/GameEnvironments";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";
import {
  resolveGameRendererId,
  type DesktopIpcSender,
} from "../DesktopIpcSenders";

const allowedSenders = ["game", "environment"] as const;

const notifyChanged = Effect.fn("desktop.ipc.environment.notifyChanged")(
  function* (
    gameRendererId: number,
    state: EnvironmentState,
    excludedRendererId: number,
  ) {
    const ipc = yield* DesktopIpc;
    const windows = yield* DesktopWindows;
    const environmentWindowIds = yield* windows.getOwnedRendererIds(
      gameRendererId,
      "environment",
    );
    const targets = [gameRendererId, ...environmentWindowIds].filter(
      (rendererId) => rendererId !== excludedRendererId,
    );
    yield* ipc.sendToRendererIds(targets, EnvironmentIpc.changed, state);
  },
);

const mutate = (
  sender: DesktopIpcSender,
  reducer: (state: EnvironmentState) => EnvironmentState,
) =>
  Effect.gen(function* () {
    const environments = yield* GameEnvironments;
    const gameRendererId = yield* resolveGameRendererId(sender);
    const state = yield* environments.update(gameRendererId, reducer);
    yield* notifyChanged(gameRendererId, state, sender.rendererId);
    return state;
  });

export const getState = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.getState,
  allowedSenders,
  handler: Effect.fn("desktop.ipc.environment.getState")(
    function* (_payload, sender) {
      const environments = yield* GameEnvironments;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* environments.get(gameRendererId);
    },
  ),
});

export const clear = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.clear,
  allowedSenders,
  handler: (_payload, sender) => mutate(sender, clearEnvironmentState),
});

export const addQuest = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addQuest,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      addEnvironmentQuest(state, payload.questId, payload.rewardItemId),
    ),
});

export const addQuests = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addQuests,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => addEnvironmentQuests(state, payload.quests)),
});

export const removeQuest = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.removeQuest,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => removeEnvironmentQuest(state, payload.questId)),
});

export const setQuestReward = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.setQuestReward,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      setEnvironmentQuestReward(state, payload.questId, payload.rewardItemId),
    ),
});

export const clearQuestReward = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.clearQuestReward,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      clearEnvironmentQuestReward(state, payload.questId),
    ),
});

export const clearQuests = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.clearQuests,
  allowedSenders,
  handler: (_payload, sender) => mutate(sender, clearEnvironmentQuests),
});

export const setQuestAutoRegister = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.setQuestAutoRegister,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      setEnvironmentQuestAutoRegisterOptions(state, payload),
    ),
});

export const setAutomationEnabled = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.setAutomationEnabled,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      setEnvironmentAutomationEnabled(
        state,
        payload.capability,
        payload.enabled,
      ),
    ),
});

export const addItem = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addItem,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => addEnvironmentItem(state, payload.name)),
});

export const addItems = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addItems,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => addEnvironmentItems(state, payload.names)),
});

export const removeItem = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.removeItem,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => removeEnvironmentItem(state, payload.name)),
});

export const setItemRules = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.setItemRules,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => setEnvironmentItemRules(state, payload)),
});

export const setItemNotification = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.setItemNotification,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) =>
      setEnvironmentItemNotification(state, payload.name, payload.enabled),
    ),
});

export const clearItems = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.clearItems,
  allowedSenders,
  handler: (_payload, sender) => mutate(sender, clearEnvironmentItems),
});

export const addBoost = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addBoost,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => addEnvironmentBoost(state, payload.name)),
});

export const addBoosts = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.addBoosts,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => addEnvironmentBoosts(state, payload.names)),
});

export const removeBoost = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.removeBoost,
  allowedSenders,
  handler: (payload, sender) =>
    mutate(sender, (state) => removeEnvironmentBoost(state, payload.name)),
});

export const clearBoosts = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.clearBoosts,
  allowedSenders,
  handler: (_payload, sender) => mutate(sender, clearEnvironmentBoosts),
});

export const fetchBoosts = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.fetchBoosts,
  allowedSenders,
  handler: Effect.fn("desktop.ipc.environment.fetchBoosts")(
    function* (_payload, sender) {
      const environments = yield* GameEnvironments;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* environments.fetchBoosts(gameRendererId);
    },
  ),
});

export const withdrawBoosts = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.withdrawBoosts,
  allowedSenders,
  handler: Effect.fn("desktop.ipc.environment.withdrawBoosts")(
    function* (payload, sender) {
      const environments = yield* GameEnvironments;
      const gameRendererId = yield* resolveGameRendererId(sender);
      return yield* environments.withdrawBoosts(
        gameRendererId,
        payload.itemIds,
      );
    },
  ),
});

export const syncToAll = makeDesktopIpcMethod({
  descriptor: EnvironmentIpc.syncToAll,
  allowedSenders,
  handler: Effect.fn("desktop.ipc.environment.syncToAll")(
    function* (_payload, sender) {
      const environments = yield* GameEnvironments;
      const windows = yield* DesktopWindows;
      const sourceGameRendererId = yield* resolveGameRendererId(sender);
      const state = yield* environments.get(sourceGameRendererId);
      const gameRendererIds = yield* windows.getRendererIds("game");

      for (const gameRendererId of gameRendererIds) {
        const copiedState = yield* environments.set(gameRendererId, state);
        yield* notifyChanged(gameRendererId, copiedState, sender.rendererId);
      }

      return state;
    },
  ),
});

export const methods = [
  getState,
  clear,
  addQuest,
  addQuests,
  removeQuest,
  setQuestReward,
  clearQuestReward,
  clearQuests,
  setQuestAutoRegister,
  setAutomationEnabled,
  addItem,
  addItems,
  removeItem,
  setItemRules,
  setItemNotification,
  clearItems,
  addBoost,
  addBoosts,
  removeBoost,
  clearBoosts,
  fetchBoosts,
  withdrawBoosts,
  syncToAll,
] as const;
