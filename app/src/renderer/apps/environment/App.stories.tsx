import type { Meta, StoryObj } from "storybook-solidjs-vite";

import {
  addEnvironmentBoosts,
  addEnvironmentItems,
  addEnvironmentQuests,
  clearEnvironmentBoosts,
  clearEnvironmentItems,
  clearEnvironmentQuestReward,
  clearEnvironmentQuests,
  clearEnvironmentState,
  createEmptyEnvironmentState,
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
import {
  EnvironmentView,
  type EnvironmentViewCallbacks,
  type EnvironmentViewProps,
} from "./App";

const configuredState: EnvironmentState = {
  automation: { boosts: true, drops: false, quests: true },
  boosts: ["Gold Boost (20 min)", "Class Points Boost (60 min)"],
  itemNames: [
    "Unidentified 13",
    "Darkon's Receipt",
    "Relic of Chaos",
    "Uni 34",
  ],
  itemNotificationNames: ["Unidentified 13", "Darkon's Receipt"],
  itemRules: {
    buckets: ["ac-member", "ac-non-member"],
    rejectElse: true,
  },
  questAutoRegister: { requirements: true, rewards: true },
  questIds: [8372, 8373, 8374, 8375],
  questRewards: { 8372: 78433, 8374: 78435 },
};

function InteractiveEnvironmentStory(props: EnvironmentViewProps) {
  let currentState = props.fixture.state;
  const commit = (next: EnvironmentState): Promise<EnvironmentState> => {
    currentState = next;
    return Promise.resolve(next);
  };
  const callbacks: EnvironmentViewCallbacks = {
    addBoosts: (names) => commit(addEnvironmentBoosts(currentState, names)),
    addItems: (names) => commit(addEnvironmentItems(currentState, names)),
    addQuests: (quests) => commit(addEnvironmentQuests(currentState, quests)),
    clear: () => commit(clearEnvironmentState(currentState)),
    clearBoosts: () => commit(clearEnvironmentBoosts(currentState)),
    clearItems: () => commit(clearEnvironmentItems(currentState)),
    clearQuestReward: (questId) =>
      commit(clearEnvironmentQuestReward(currentState, questId)),
    clearQuests: () => commit(clearEnvironmentQuests(currentState)),
    fetchBoosts: () =>
      Promise.resolve({
        bank: [
          { itemId: 91001, name: "Reputation Boost (60 min)", quantity: 2 },
        ],
        bankLoaded: true,
        inventory: ["Experience Boost (20 min)"],
      }),
    removeBoost: (name) => commit(removeEnvironmentBoost(currentState, name)),
    removeItem: (name) => commit(removeEnvironmentItem(currentState, name)),
    removeQuest: (questId) =>
      commit(removeEnvironmentQuest(currentState, questId)),
    setAutomationEnabled: (capability, enabled) =>
      commit(
        setEnvironmentAutomationEnabled(currentState, capability, enabled),
      ),
    setItemNotification: (name, enabled) =>
      commit(setEnvironmentItemNotification(currentState, name, enabled)),
    setItemRules: (rules) =>
      commit(setEnvironmentItemRules(currentState, rules)),
    setQuestAutoRegister: (options) =>
      commit(setEnvironmentQuestAutoRegisterOptions(currentState, options)),
    setQuestReward: (questId, rewardItemId) =>
      commit(setEnvironmentQuestReward(currentState, questId, rewardItemId)),
    syncToAll: () => Promise.resolve(currentState),
    withdrawBoosts: (itemIds) => Promise.resolve(itemIds),
    ...props.callbacks,
  };

  return <EnvironmentView {...props} callbacks={callbacks} />;
}

const meta = {
  args: {
    fixture: { state: configuredState },
  },
  component: EnvironmentView,
  globals: {
    viewport: { isRotated: false, value: "environment" },
  },
  render: (args) => <InteractiveEnvironmentStory {...args} />,
  title: "Renderers/Environment",
} satisfies Meta<typeof EnvironmentView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {};

export const Empty: Story = {
  args: {
    fixture: { state: createEmptyEnvironmentState() },
  },
};

export const AutomationFailure: Story = {
  args: {
    fixture: {
      error: "The game did not respond in time. Try again.",
      state: configuredState,
    },
  },
};

export const LargeLists: Story = {
  args: {
    fixture: {
      state: {
        ...configuredState,
        boosts: Array.from(
          { length: 12 },
          (_, index) => `Boost ${String(index + 1).padStart(2, "0")}`,
        ),
        itemNames: Array.from(
          { length: 18 },
          (_, index) => `Tracked drop ${String(index + 1).padStart(2, "0")}`,
        ),
        questIds: Array.from({ length: 16 }, (_, index) => 9000 + index),
      },
    },
  },
};
