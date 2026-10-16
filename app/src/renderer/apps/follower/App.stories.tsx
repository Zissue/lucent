import type { Meta, StoryObj } from "storybook-solidjs-vite";

import {
  DEFAULT_COMBAT_PROFILE_LIBRARY,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import type { FollowerConfig, FollowerState } from "@lucent/core/follower";
import {
  FollowerView,
  type FollowerViewCallbacks,
  type FollowerViewProps,
} from "./App";

const library: CombatProfileLibrary = {
  version: 1,
  profiles: [
    ...DEFAULT_COMBAT_PROFILE_LIBRARY.profiles,
    {
      classNames: ["Lord of Order"],
      cooldownMode: "use-if-ready",
      delayMs: 180,
      id: "support",
      label: "Party Support",
      steps: [
        { conditions: [], skill: 2 },
        { conditions: [], skill: 3 },
        { conditions: [], skill: 4 },
      ],
    },
  ],
};

const config: FollowerConfig = {
  attackPriority: [17, "Darkon"],
  combatEnabled: true,
  copyWalk: true,
  lockedZoneFallbacks: ["battleon", "yulgar-9999"],
  lockedZoneRoomOverride: "4040",
  maxAttempts: 3,
  retryEnabled: true,
  selectedProfileId: "support",
  targetName: "partyLead",
};

const followingState: FollowerState = {
  attemptsRemaining: 3,
  enabled: true,
  phase: "combat",
  profileId: "support",
  profileLabel: "Party Support",
  running: true,
  targetName: "partylead",
};

function InteractiveFollowerStory(props: FollowerViewProps) {
  let currentState = props.fixture.state;
  const commit = (next: FollowerState): Promise<FollowerState> => {
    currentState = next;
    return Promise.resolve(next);
  };
  const callbacks: FollowerViewCallbacks = {
    configure: () => Promise.resolve(currentState),
    me: () => Promise.resolve(props.fixture.players?.[0] ?? "PartyLead"),
    openCombatProfiles: () => Promise.resolve(),
    start: (configuration) => {
      const profile = props.fixture.library.profiles.find(
        (candidate) => candidate.id === configuration.selectedProfileId,
      );
      return commit({
        attemptsRemaining: configuration.maxAttempts ?? 3,
        enabled: true,
        phase: "following",
        ...(profile === undefined
          ? {}
          : { profileId: profile.id, profileLabel: profile.label }),
        running: true,
        targetName: configuration.targetName.trim().toLowerCase(),
      });
    },
    stop: () =>
      commit({
        attemptsRemaining: currentState.attemptsRemaining,
        enabled: false,
        phase: "idle",
        ...(currentState.profileId === undefined
          ? {}
          : { profileId: currentState.profileId }),
        ...(currentState.profileLabel === undefined
          ? {}
          : { profileLabel: currentState.profileLabel }),
        running: false,
        targetName: currentState.targetName,
      }),
    ...props.callbacks,
  };

  return <FollowerView {...props} callbacks={callbacks} />;
}

const meta = {
  args: {
    fixture: {
      config,
      library,
      players: ["PartyLead", "LucentHealer", "LoopTaunt", "DamageDealer"],
      state: followingState,
    },
  },
  component: FollowerView,
  globals: {
    viewport: { isRotated: false, value: "follower" },
  },
  render: (args) => <InteractiveFollowerStory {...args} />,
  title: "Renderers/Follower",
} satisfies Meta<typeof FollowerView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FollowingInCombat: Story = {};

export const ConsumableWarning: Story = {
  args: {
    fixture: {
      config,
      library,
      players: ["PartyLead", "LucentHealer", "LoopTaunt", "DamageDealer"],
      state: {
        ...followingState,
        warning:
          "Lucent could not equip Potent Honor Potion while you were in combat. Skill 5 will use whichever consumable is available.",
      },
    },
  },
};

export const ReadyToStart: Story = {
  args: {
    fixture: {
      config,
      library,
      players: ["PartyLead", "LucentHealer", "LoopTaunt"],
      state: {
        attemptsRemaining: 3,
        enabled: false,
        phase: "idle",
        running: false,
        targetName: "",
      },
    },
  },
};

export const NoPlayersInMap: Story = {
  args: {
    fixture: {
      config: { ...config, targetName: "" },
      library,
      players: [],
      state: {
        attemptsRemaining: 3,
        enabled: false,
        phase: "idle",
        running: false,
        targetName: "",
      },
    },
  },
};

export const RetriesExhausted: Story = {
  args: {
    fixture: {
      config,
      library,
      players: ["LucentHealer", "LoopTaunt"],
      state: {
        attemptsRemaining: 0,
        enabled: false,
        lastError: "Player PartyLead was not found in the current room.",
        phase: "stopped",
        running: false,
        stoppedReason: "Follow attempts exhausted",
        targetName: "partylead",
      },
    },
  },
};

export const ConfigurationError: Story = {
  args: {
    fixture: {
      config,
      error: "Follower configuration could not be synchronized.",
      library,
      players: ["PartyLead"],
      state: followingState,
    },
  },
};
