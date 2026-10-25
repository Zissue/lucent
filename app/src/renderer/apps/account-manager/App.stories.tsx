import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type {
  AccountGameServer,
  AccountGameServerPing,
  AccountManagerState,
} from "@lucent/core/accounts";
import { AccountManagerView } from "./App";

const emptyState: AccountManagerState = {
  accounts: [],
  groups: {},
  sessions: [],
  storagePath: "/fixture-data/Lucent/accounts.json",
};

const populatedState: AccountManagerState = {
  accounts: [
    { label: "Main", password: "secret", username: "PrimaryHero" },
    { label: "Support", password: "secret", username: "LucentHealer" },
    { label: "Taunter", password: "secret", username: "LoopTaunt" },
    { label: "DPS", password: "secret", username: "DamageDealer" },
    { label: "Bank alt", password: "secret", username: "VaultKeeper" },
  ],
  groups: {
    "Darkon team": ["PrimaryHero", "LucentHealer", "LoopTaunt", "DamageDealer"],
    Farming: ["PrimaryHero", "VaultKeeper"],
  },
  sessions: [],
  storagePath: "/fixture-data/Lucent/accounts.json",
};

const servers: readonly AccountGameServer[] = [
  {
    language: "en",
    maxPlayers: 1500,
    name: "Artix",
    online: true,
    playerCount: 1498,
    upgrade: false,
  },
  {
    language: "en",
    maxPlayers: 1000,
    name: "Yorumi",
    online: true,
    playerCount: 721,
    upgrade: false,
  },
  {
    language: "en",
    maxPlayers: 1000,
    name: "Safiria",
    online: true,
    playerCount: 1000,
    upgrade: false,
  },
  {
    language: "pt",
    maxPlayers: 1000,
    name: "Espada",
    online: false,
    playerCount: 0,
    upgrade: false,
  },
  {
    language: "en",
    maxPlayers: 250,
    name: "TestingServer",
    online: true,
    playerCount: 247,
    upgrade: true,
  },
];

const serverPings: readonly AccountGameServerPing[] = [
  { latencyMs: 42, serverName: "Artix", status: "ok" },
  { latencyMs: 143, serverName: "Yorumi", status: "ok" },
  { serverName: "Safiria", status: "timeout" },
  { serverName: "Espada", status: "offline" },
  { serverName: "TestingServer", status: "unreachable" },
];

const meta = {
  args: {
    fixture: {
      launchServer: "Artix",
      selectedAccountUsernames: ["PrimaryHero", "LucentHealer"],
      serverPings,
      servers,
      state: populatedState,
      useGameTabs: true,
    },
    platform: "mac",
  },
  component: AccountManagerView,
  globals: {
    viewport: { isRotated: false, value: "accountManager" },
  },
  parameters: {
    docs: {
      description: {
        component:
          "The production Account Manager rendered from account, session, and server fixtures without an Electron bridge.",
      },
    },
  },
  title: "Renderers/Account Manager",
} satisfies Meta<typeof AccountManagerView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LaunchSelection: Story = {};

export const Loading: Story = {
  args: {
    fixture: {
      initialLoadingVisible: true,
      state: emptyState,
      stateLoaded: false,
    },
  },
};

export const Empty: Story = {
  args: { fixture: { state: emptyState } },
};

export const NoSearchResults: Story = {
  args: {
    fixture: {
      searchQuery: "missing account",
      state: populatedState,
    },
  },
};

export const ServerAndScriptErrors: Story = {
  args: {
    fixture: {
      scriptError: "The selected script could not be parsed at line 18.",
      serverError: "Server status is temporarily unavailable.",
      state: populatedState,
    },
  },
};

export const AccountSaveError: Story = {
  args: {
    fixture: {
      dialog: {
        account: populatedState.accounts[0]!,
        error: "An account with that username already exists.",
        mode: "edit",
      },
      state: populatedState,
    },
  },
};

export const GroupRenameError: Story = {
  args: {
    fixture: {
      groupDialog: {
        error: "A saved group with that name already exists.",
        name: "Darkon team",
      },
      state: populatedState,
    },
  },
};

export const GroupDeleteError: Story = {
  args: {
    fixture: {
      groupDeleteDialog: {
        error: "The group changed on disk and could not be removed.",
        name: "Darkon team",
      },
      state: populatedState,
    },
  },
};

export const MixedSessionStatuses: Story = {
  args: {
    fixture: {
      activeTab: "sessions",
      state: {
        ...populatedState,
        sessions: [
          {
            connection: { state: "online", username: "PrimaryHero" },
            gameWindowId: 101,
            launch: {
              requestedAt: 1,
              scriptName: "Legion farm",
              username: "PrimaryHero",
            },
            login: { state: "idle" },
            rendererGeneration: 1,
            revision: 5,
            script: { name: "Legion farm", state: "running" },
            updatedAt: 5,
          },
          {
            connection: { state: "offline" },
            gameWindowId: 102,
            launch: {
              requestedAt: 2,
              scriptName: "Support loop",
              username: "LucentHealer",
            },
            login: { state: "waiting-for-game" },
            rendererGeneration: 1,
            revision: 4,
            script: {
              message: "Loading the game",
              name: "Support loop",
              state: "starting",
            },
            updatedAt: 4,
          },
          {
            connection: { state: "online", username: "LoopTaunt" },
            gameWindowId: 103,
            launch: {
              requestedAt: 3,
              scriptName: "Taunt loop",
              username: "LoopTaunt",
            },
            login: { state: "idle" },
            rendererGeneration: 1,
            revision: 3,
            script: {
              message: "Script stopped after completing 12 cycles",
              name: "Taunt loop",
              state: "stopped",
            },
            updatedAt: 3,
          },
          {
            connection: { state: "online", username: "DamageDealer" },
            gameWindowId: 104,
            launch: {
              requestedAt: 4,
              scriptName: "Darkon DPS",
              username: "DamageDealer",
            },
            login: { state: "idle" },
            rendererGeneration: 1,
            revision: 2,
            script: {
              message: "Package dependency could not be resolved",
              name: "Darkon DPS",
              state: "failed",
            },
            updatedAt: 2,
          },
          {
            connection: { state: "online", username: "VaultKeeper" },
            gameWindowId: 105,
            login: { state: "idle" },
            rendererGeneration: 1,
            revision: 1,
            script: { state: "idle" },
            updatedAt: 1,
          },
        ],
      },
    },
  },
};

export const ServerAvailabilityAndPingFailures: Story = {
  args: {
    fixture: {
      launchServer: "Artix",
      selectedAccountUsernames: [
        "PrimaryHero",
        "LucentHealer",
        "LoopTaunt",
        "DamageDealer",
      ],
      serverComboboxOpen: true,
      serverPings,
      servers,
      state: populatedState,
    },
  },
};

export const ServerPingsLoading: Story = {
  args: {
    fixture: {
      serverComboboxOpen: true,
      serverPingsLoading: true,
      servers,
      state: populatedState,
    },
  },
};
