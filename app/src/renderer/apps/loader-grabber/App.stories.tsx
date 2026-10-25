import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type { GrabbedQuest } from "../../../shared/loader-grabber";
import { LoaderGrabberView } from "./App";

const quests: readonly GrabbedQuest[] = [
  {
    cadence: "daily",
    id: 8372,
    name: "The First Observatory",
    once: false,
    requirements: [
      { itemId: 78420, name: "Observation Notes", quantity: 12 },
      { itemId: 78421, name: "Unstable Lens", quantity: 1 },
    ],
    rewards: [
      { dropChance: 100, itemId: 78433, name: "Darkon's Receipt", quantity: 1 },
      { dropChance: 2, itemId: 78434, name: "Astral Mantle", quantity: 1 },
    ],
  },
  {
    cadence: "none",
    id: 8373,
    name: "A Deal in the Dark",
    once: false,
    requirements: [{ itemId: 78433, name: "Darkon's Receipt", quantity: 22 }],
    rewards: [{ itemId: 78441, name: "Insignia of the Astral", quantity: 1 }],
  },
  {
    cadence: "weekly",
    id: 8374,
    name: "The Final Observatory",
    once: false,
    requirements: [
      { itemId: 78441, name: "Insignia of the Astral", quantity: 5 },
    ],
    rewards: [
      { dropChance: 100, itemId: 78450, name: "Astral Fragment", quantity: 2 },
    ],
  },
];

const meta = {
  args: {
    fixture: {
      grabbedData: quests,
      grabbedType: "quest",
      source: "quest",
      sourceId: "8372",
    },
    onCopyText: () => Promise.resolve(),
  },
  component: LoaderGrabberView,
  globals: {
    viewport: { isRotated: false, value: "loaderGrabber" },
  },
  title: "Renderers/Loader Grabber",
} satisfies Meta<typeof LoaderGrabberView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const QuestResults: Story = {};

export const Empty: Story = {
  args: { fixture: {} },
};

export const NoDataReturned: Story = {
  args: {
    fixture: {
      notice: "The selected source did not return any data.",
      source: "inventory",
    },
  },
};

export const GrabError: Story = {
  args: {
    fixture: {
      error: "The game did not return the requested shop data.",
      source: "shop",
      sourceId: "1550",
    },
  },
};

export const FilteredResults: Story = {
  args: {
    fixture: {
      grabbedData: quests,
      grabbedType: "quest",
      search: "final",
      source: "quest",
    },
  },
};
