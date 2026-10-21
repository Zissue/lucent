import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMemo, createSignal, type JSX } from "solid-js";

import { DEFAULT_HOTKEYS } from "@lucent/core/hotkeys";
import type { AutoZoneSupportedMap } from "./automation/AutoZone";
import type { RenderingMode } from "./flash/contract/Settings";
import {
  TopNav,
  type GameTopNavMenu,
  type TopNavCombatProfile,
  type TopNavOptionItem,
  type TopNavToggleOptionItem,
} from "./TopNav";

interface TopNavFixture {
  readonly autoAttackEnabled?: boolean;
  readonly autoAttackLastError?: string;
  readonly autoAttackWarnings?: readonly string[];
  readonly autoReloginAttempting?: boolean;
  readonly autoReloginAttemptsRemaining?: number | null;
  readonly autoReloginEnabled?: boolean;
  readonly autoReloginLastError?: string;
  readonly autoReloginWaitingDelay?: boolean;
  readonly autoZoneEnabled?: boolean;
  readonly autoZoneMap?: AutoZoneSupportedMap;
  readonly combatProfiles?: readonly TopNavCombatProfile[];
  readonly gameLoaded?: boolean;
  readonly openMenu?: GameTopNavMenu | null;
  readonly playerReady?: boolean;
  readonly renderingMode?: RenderingMode;
  readonly renderingModePending?: boolean;
  readonly scriptLoaded?: boolean;
  readonly scriptOptionsReady?: boolean;
  readonly scriptRunning?: boolean;
  readonly scriptTogglePending?: boolean;
  readonly travelBusy?: boolean;
}

const profiles: readonly TopNavCombatProfile[] = [
  { id: "generic", label: "Generic" },
  {
    classNames: ["Lord of Order"],
    id: "support",
    label: "Party Support",
  },
  {
    classNames: ["Lord of Order"],
    id: "support-safe",
    label: "Defensive Support",
  },
  {
    classNames: ["Void Highlord", "Void Highlord (IoDA)", "Debris Highlord"],
    id: "dot-solo",
    label: "Void Highlord Solo",
  },
];

const optionFixtures = [
  ["infinite-range", "Infinite range", true],
  ["provoke-cell", "Provoke cell", false],
  ["enemy-magnet", "Enemy magnet", true],
  ["hide-players", "Hide players", false],
  ["skip-cutscenes", "Skip cutscenes", true],
  ["anti-counter", "Anti-counter", false],
  ["animations", "Animations", true],
  ["collisions", "Collisions", false],
  ["death-ads", "Death ads", false],
] as const;

function TopNavStory(props: { readonly fixture: TopNavFixture }): JSX.Element {
  const fixture = props.fixture;
  const combatProfiles = fixture.combatProfiles ?? profiles;
  const [openMenu, setOpenMenu] = createSignal<GameTopNavMenu | null>(
    fixture.openMenu ?? null,
  );
  const [walkSpeed, setWalkSpeed] = createSignal("8");
  const [frameRate, setFrameRate] = createSignal("30");
  const [customName, setCustomName] = createSignal("Lucent Preview");
  const [customGuild, setCustomGuild] = createSignal("Storybook");
  const [autoAttackPriority, setAutoAttackPriority] =
    createSignal("id:17, Darkon");
  const [autoReloginDelay, setAutoReloginDelay] = createSignal("5");
  const [autoAttackEnabled, setAutoAttackEnabled] = createSignal(
    fixture.autoAttackEnabled ?? true,
  );
  const [autoReloginEnabled, setAutoReloginEnabled] = createSignal(
    fixture.autoReloginEnabled ?? true,
  );
  const [autoReloginServer, setAutoReloginServer] = createSignal("Artix");
  const [autoZoneEnabled, setAutoZoneEnabled] = createSignal(
    fixture.autoZoneEnabled ?? true,
  );
  const [autoZoneMap, setAutoZoneMap] = createSignal<
    AutoZoneSupportedMap | undefined
  >(fixture.autoZoneMap ?? "astralshrine");
  const [scriptRunning, setScriptRunning] = createSignal(
    fixture.scriptRunning ?? true,
  );
  const [selectedProfileId, setSelectedProfileId] = createSignal("support");
  const [selectedCell, setSelectedCell] = createSignal("Boss");
  const [selectedPad, setSelectedPad] = createSignal("Spawn");
  const toggleOptions = optionFixtures.map(([id, label, initialChecked]) => {
    const [checked, setChecked] = createSignal(initialChecked);
    return { checked, id, label, setChecked };
  });
  const [renderingMode, setRenderingMode] = createSignal<RenderingMode>(
    fixture.renderingMode ?? "full",
  );
  const optionItems = createMemo<readonly TopNavOptionItem[]>(() => {
    const toggles = toggleOptions.map(
      (option): TopNavToggleOptionItem => ({
        checked: option.checked(),
        id: option.id,
        label: option.label,
        onCheckedChange: option.setChecked,
        type: "toggle",
      }),
    );

    return [
      ...toggles.slice(0, 3),
      {
        id: "rendering-mode",
        label: "Rendering Mode",
        mode: renderingMode(),
        onModeChange: setRenderingMode,
        pending: fixture.renderingModePending ?? false,
        type: "rendering-mode",
      },
      ...toggles.slice(3),
    ];
  });
  const selectedProfile = () =>
    combatProfiles.find((profile) => profile.id === selectedProfileId()) ??
    combatProfiles[0];

  return (
    <div class="game-app">
      <TopNav
        autoAttackConfiguredProfileLabel={() =>
          selectedProfile()?.label ?? "Generic"
        }
        autoAttackEnabled={autoAttackEnabled}
        autoAttackLastError={() => fixture.autoAttackLastError ?? ""}
        autoAttackWarnings={() => fixture.autoAttackWarnings ?? []}
        autoAttackProfileLabel={() => selectedProfile()?.label ?? "Generic"}
        autoAttackTargetPriority={autoAttackPriority}
        autoReloginAttempting={() => fixture.autoReloginAttempting ?? false}
        autoReloginAttemptsRemaining={() =>
          fixture.autoReloginAttemptsRemaining ?? null
        }
        autoReloginCaptured={() => true}
        autoReloginDelaySeconds={autoReloginDelay}
        autoReloginEnabled={autoReloginEnabled}
        autoReloginLastError={() => fixture.autoReloginLastError ?? ""}
        autoReloginServer={autoReloginServer}
        autoReloginServers={() => ["Artix", "Yorumi", "Safiria"]}
        autoReloginToggling={() => false}
        autoReloginWaitingDelay={() => fixture.autoReloginWaitingDelay ?? false}
        autoZoneEnabled={autoZoneEnabled}
        autoZoneMap={autoZoneMap}
        cells={() => ["Enter", "Boss", "Rewards"]}
        combatProfiles={() => combatProfiles}
        customGuild={customGuild}
        customGuildConfigured={() => true}
        customName={customName}
        customNameConfigured={() => true}
        frameRate={frameRate}
        gameLoaded={() => fixture.gameLoaded ?? true}
        handleOpenBank={() => undefined}
        handleOpenWindow={() => undefined}
        handleReloadMap={() => undefined}
        handleRefreshAutoReloginServers={() => undefined}
        handleRefreshTravelOptions={() => undefined}
        handleResetCustomGuild={() => setCustomGuild("")}
        handleResetCustomName={() => setCustomName("")}
        handleSelectAutoAttackProfile={setSelectedProfileId}
        handleSelectAutoZoneMap={setAutoZoneMap}
        handleSelectAutoReloginServer={setAutoReloginServer}
        handleSelectCell={setSelectedCell}
        handleSelectPad={setSelectedPad}
        handleSetAutoReloginDelay={() => undefined}
        handleSetCustomGuild={() => undefined}
        handleSetCustomName={() => undefined}
        handleSetFrameRate={(rate) => setFrameRate(String(rate))}
        handleSetSpawnPoint={() => undefined}
        handleSetWalkSpeed={(speed) => setWalkSpeed(String(speed))}
        handleToggleAutoAttack={() =>
          setAutoAttackEnabled((current) => !current)
        }
        handleToggleAutoRelogin={() =>
          setAutoReloginEnabled((current) => !current)
        }
        handleToggleAutoZone={() => setAutoZoneEnabled((current) => !current)}
        hotkeyBindings={() => DEFAULT_HOTKEYS.bindings}
        hotkeyPlatform="mac"
        openMenu={openMenu}
        openScripts={() => undefined}
        optionItems={optionItems}
        pads={() => ["Spawn", "Left", "Right"]}
        playerReady={() => fixture.playerReady ?? true}
        scriptLoaded={() => fixture.scriptLoaded ?? true}
        scriptOptionsReady={() => fixture.scriptOptionsReady ?? true}
        scriptRunning={scriptRunning}
        scriptTogglePending={() => fixture.scriptTogglePending ?? false}
        selectedAutoAttackProfileId={selectedProfileId}
        selectedCell={selectedCell}
        selectedPad={selectedPad}
        setAutoAttackTargetPriority={setAutoAttackPriority}
        setAutoReloginDelaySeconds={setAutoReloginDelay}
        setCustomGuild={setCustomGuild}
        setCustomName={setCustomName}
        setFrameRate={setFrameRate}
        setOpenMenu={setOpenMenu}
        setWalkSpeed={setWalkSpeed}
        toggleScript={() => {
          setScriptRunning((current) => !current);
        }}
        travelBusy={() => fixture.travelBusy ?? false}
        validPads={() => ["Spawn", "Left"]}
        walkSpeed={walkSpeed}
      />
    </div>
  );
}

const meta = {
  args: { fixture: {} },
  component: TopNavStory,
  globals: {
    viewport: { isRotated: false, value: "game" },
  },
  title: "Game/TopNav",
} satisfies Meta<typeof TopNavStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningScript: Story = {};

export const GameNotReady: Story = {
  args: {
    fixture: {
      gameLoaded: false,
      playerReady: false,
      scriptLoaded: false,
      scriptOptionsReady: false,
      scriptRunning: false,
    },
  },
};

export const ScriptStarting: Story = {
  args: {
    fixture: {
      scriptLoaded: true,
      scriptOptionsReady: false,
      scriptRunning: false,
      scriptTogglePending: true,
    },
  },
};

export const AutoAttackFailure: Story = {
  args: {
    fixture: {
      autoAttackEnabled: false,
      autoAttackLastError: "Combat profile failed while resolving target 17.",
      openMenu: "combat",
    },
  },
};

export const AutoAttackProfiles: Story = {
  args: {
    fixture: { autoAttackEnabled: false, openMenu: "combat" },
  },
};

export const AutoAttackManyProfiles: Story = {
  args: {
    fixture: {
      autoAttackEnabled: false,
      openMenu: "combat",
      combatProfiles: [
        ...profiles,
        ...Array.from({ length: 1000 }, (_, index) => ({
          id: `profile-${index}`,
          label: `Profile ${index}`,
          classNames: [`Class ${index % 100}`, `Alias ${index % 100}`],
        })),
      ],
    },
  },
};

export const AutoAttackConsumableWarning: Story = {
  args: {
    fixture: {
      autoAttackEnabled: true,
      autoAttackWarnings: [
        "Could not equip Potent Honor Potion while you were in combat. Skill 5 will use whichever consumable is equipped.",
      ],
      openMenu: "combat",
    },
  },
};

export const AutoAttackClassAndConsumableWarnings: Story = {
  args: {
    fixture: {
      autoAttackEnabled: true,
      autoAttackWarnings: [
        "This profile is for Lord of Order, but Legion Revenant is equipped.",
        "Could not equip Potent Honor Potion while you were in combat. Skill 5 will use whichever consumable is equipped.",
      ],
      openMenu: "combat",
    },
  },
};

export const AutoReloginReconnecting: Story = {
  args: {
    fixture: {
      autoReloginAttempting: true,
      autoReloginAttemptsRemaining: 1,
      openMenu: "relogin",
    },
  },
};

export const AutoReloginFailed: Story = {
  args: {
    fixture: {
      autoReloginEnabled: false,
      autoReloginLastError: "Artix rejected the saved login session.",
      openMenu: "relogin",
    },
  },
};

export const OptionsMenu: Story = {
  args: { fixture: { openMenu: "options" } },
};

export const RenderingModePending: Story = {
  args: {
    fixture: {
      openMenu: "options",
      renderingMode: "minimal",
      renderingModePending: true,
    },
  },
};

export const TravelBusy: Story = {
  args: { fixture: { openMenu: "travel", travelBusy: true } },
};
