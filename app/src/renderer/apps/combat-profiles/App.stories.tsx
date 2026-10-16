import type { Meta, StoryObj } from "storybook-solidjs-vite";

import {
  DEFAULT_COMBAT_PROFILE_LIBRARY,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import { CombatProfilesView, type CombatProfilesViewProps } from "./App";

const library: CombatProfileLibrary = {
  version: 1,
  profiles: [
    ...DEFAULT_COMBAT_PROFILE_LIBRARY.profiles,
    {
      classNames: ["Dragon of Time"],
      cooldownMode: "wait-for-cooldown",
      delayMs: 125,
      id: "dot-solo",
      label: "Dragon of Time Solo",
      messageTriggers: [
        {
          cooldownMs: 12_000,
          messageIncludes: "Temporal Rift fades",
          skill: 4,
          source: "aura",
        },
      ],
      resetSkillIndexOnTargetDeath: true,
      steps: [
        {
          conditions: [
            { op: "<=", type: "self-hp", unit: "percent", value: 45 },
          ],
          priority: true,
          skill: 3,
        },
        {
          conditions: [
            {
              auraName: "Temporal Rift",
              op: ">=",
              type: "self-aura",
              value: 4,
            },
          ],
          skill: 5,
        },
        { conditions: [], skill: 2, waitMs: 250 },
        { conditions: [], skill: 4 },
      ],
    },
  ],
};

function InteractiveCombatProfilesStory(props: CombatProfilesViewProps) {
  let currentLibrary = props.fixture.library;

  return (
    <CombatProfilesView
      {...props}
      onDeleteProfile={
        props.onDeleteProfile ??
        ((profileId) => {
          currentLibrary = {
            ...currentLibrary,
            profiles: currentLibrary.profiles.filter(
              (profile) => profile.id !== profileId,
            ),
          };
          return Promise.resolve(currentLibrary);
        })
      }
      onSaveProfile={
        props.onSaveProfile ??
        ((profile) => {
          const existingIndex = currentLibrary.profiles.findIndex(
            (candidate) => candidate.id === profile.id,
          );
          currentLibrary = {
            ...currentLibrary,
            profiles:
              existingIndex === -1
                ? [...currentLibrary.profiles, profile]
                : currentLibrary.profiles.map((candidate) =>
                    candidate.id === profile.id ? profile : candidate,
                  ),
          };
          return Promise.resolve(currentLibrary);
        })
      }
    />
  );
}

const meta = {
  args: {
    fixture: { library, selectedProfileId: "dot-solo" },
    onCopyText: () => Promise.resolve(),
  },
  component: CombatProfilesView,
  globals: {
    viewport: { isRotated: false, value: "combatProfiles" },
  },
  render: (args) => <InteractiveCombatProfilesStory {...args} />,
  title: "Renderers/Combat Profiles",
} satisfies Meta<typeof CombatProfilesView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProfileWithRules: Story = {};

export const GenericProfile: Story = {
  args: {
    fixture: {
      library,
      selectedProfileId: "generic-base",
    },
  },
};

export const EmptyRotation: Story = {
  args: {
    fixture: {
      library: {
        version: 1,
        profiles: [
          {
            cooldownMode: "use-if-ready",
            delayMs: 150,
            id: "empty",
            label: "Empty profile",
            messageTriggers: [],
            steps: [],
          },
        ],
      },
      selectedProfileId: "empty",
    },
  },
};

export const SaveError: Story = {
  args: {
    fixture: {
      error:
        "The profile library changed on disk. Reopen the editor and try again.",
      library,
      selectedProfileId: "dot-solo",
    },
  },
};
