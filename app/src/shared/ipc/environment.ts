import {
  EnvironmentAutomationCapabilitySchema,
  EnvironmentItemRulesSchema,
  EnvironmentQuestAutoRegisterOptionsSchema,
  EnvironmentStateSchema,
} from "@lucent/core/environment";
import { PositiveInt } from "@lucent/core";
import * as Schema from "effect/Schema";

import { EnvironmentBoostDiscoverySchema } from "../environmentBoosts";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:environment";

export const EnvironmentIpc = {
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  clear: defineInvoke({
    channel: `${namespace}:clear`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  addQuest: defineInvoke({
    channel: `${namespace}:add-quest`,
    payload: Schema.Struct({
      questId: PositiveInt,
      rewardItemId: Schema.optionalKey(PositiveInt),
    }),
    result: EnvironmentStateSchema,
  }),
  addQuests: defineInvoke({
    channel: `${namespace}:add-quests`,
    payload: Schema.Struct({
      quests: Schema.Array(
        Schema.Struct({
          questId: PositiveInt,
          rewardItemId: Schema.optionalKey(PositiveInt),
        }),
      ),
    }),
    result: EnvironmentStateSchema,
  }),
  removeQuest: defineInvoke({
    channel: `${namespace}:remove-quest`,
    payload: Schema.Struct({
      questId: PositiveInt,
    }),
    result: EnvironmentStateSchema,
  }),
  setQuestReward: defineInvoke({
    channel: `${namespace}:set-quest-reward`,
    payload: Schema.Struct({
      questId: PositiveInt,
      rewardItemId: PositiveInt,
    }),
    result: EnvironmentStateSchema,
  }),
  clearQuestReward: defineInvoke({
    channel: `${namespace}:clear-quest-reward`,
    payload: Schema.Struct({
      questId: PositiveInt,
    }),
    result: EnvironmentStateSchema,
  }),
  clearQuests: defineInvoke({
    channel: `${namespace}:clear-quests`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  setQuestAutoRegister: defineInvoke({
    channel: `${namespace}:set-quest-auto-register`,
    payload: EnvironmentQuestAutoRegisterOptionsSchema,
    result: EnvironmentStateSchema,
  }),
  setAutomationEnabled: defineInvoke({
    channel: `${namespace}:set-automation-enabled`,
    payload: Schema.Struct({
      capability: EnvironmentAutomationCapabilitySchema,
      enabled: Schema.Boolean,
    }),
    result: EnvironmentStateSchema,
  }),
  addItem: defineInvoke({
    channel: `${namespace}:add-item`,
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: EnvironmentStateSchema,
  }),
  addItems: defineInvoke({
    channel: `${namespace}:add-items`,
    payload: Schema.Struct({
      names: Schema.Array(Schema.String),
    }),
    result: EnvironmentStateSchema,
  }),
  removeItem: defineInvoke({
    channel: `${namespace}:remove-item`,
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: EnvironmentStateSchema,
  }),
  setItemRules: defineInvoke({
    channel: `${namespace}:set-item-rules`,
    payload: EnvironmentItemRulesSchema,
    result: EnvironmentStateSchema,
  }),
  setItemNotification: defineInvoke({
    channel: `${namespace}:set-item-notification`,
    payload: Schema.Struct({
      enabled: Schema.Boolean,
      name: Schema.String,
    }),
    result: EnvironmentStateSchema,
  }),
  clearItems: defineInvoke({
    channel: `${namespace}:clear-items`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  addBoost: defineInvoke({
    channel: `${namespace}:add-boost`,
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: EnvironmentStateSchema,
  }),
  addBoosts: defineInvoke({
    channel: `${namespace}:add-boosts`,
    payload: Schema.Struct({
      names: Schema.Array(Schema.String),
    }),
    result: EnvironmentStateSchema,
  }),
  removeBoost: defineInvoke({
    channel: `${namespace}:remove-boost`,
    payload: Schema.Struct({
      name: Schema.String,
    }),
    result: EnvironmentStateSchema,
  }),
  clearBoosts: defineInvoke({
    channel: `${namespace}:clear-boosts`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  fetchBoosts: defineInvoke({
    channel: `${namespace}:fetch-boosts`,
    payload: Schema.Void,
    result: EnvironmentBoostDiscoverySchema,
  }),
  withdrawBoosts: defineInvoke({
    channel: `${namespace}:withdraw-boosts`,
    payload: Schema.Struct({
      itemIds: Schema.Array(PositiveInt),
    }),
    result: Schema.Array(PositiveInt),
  }),
  syncToAll: defineInvoke({
    channel: `${namespace}:sync-to-all`,
    payload: Schema.Void,
    result: EnvironmentStateSchema,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: EnvironmentStateSchema,
  }),
} as const;
