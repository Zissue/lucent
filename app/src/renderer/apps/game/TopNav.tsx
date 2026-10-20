import {
  Button,
  Icon,
  Input,
  Kbd,
  Label,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  VirtualizedMenuRadioGroup,
  cn,
  type ButtonProps,
  type MenuContentProps,
  type MenuSubContentProps,
} from "@lucent/ui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  splitProps,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js";
import { Portal } from "solid-js/web";

import type { AppPlatform } from "../../../shared/desktopBridge";
import {
  formatHotkeyDisplay,
  readHotkeyBinding,
  type HotkeyBinding,
  type SettingsCommandId,
} from "@lucent/core/hotkeys";
import {
  AUTO_ZONE_MAP_OPTIONS,
  type AutoZoneSupportedMap,
} from "./automation/AutoZone";
import type { RenderingMode } from "./flash/contract/Settings";
import {
  buildCombatProfileOptions,
  resolveCombatProfileOptionValue,
} from "../../combatProfileOptions";

export type GameTopNavMenu =
  | "windows"
  | "options"
  | "combat"
  | "autozone"
  | "relogin"
  | "travel";
export type WindowId =
  | "environment"
  | "loader-grabber"
  | "follower"
  | "packets"
  | "account-manager"
  | "combat-profiles";

export interface TopNavCombatProfile {
  readonly classNames?: readonly string[];
  readonly id: string;
  readonly label: string;
}

export interface TopNavToggleOptionItem {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly type: "toggle";
  readonly onCheckedChange: (checked: boolean) => void;
}

export interface TopNavRenderingModeOptionItem {
  readonly disabled?: boolean;
  readonly id: "rendering-mode";
  readonly label: "Rendering Mode";
  readonly mode: RenderingMode;
  readonly pending?: boolean;
  readonly type: "rendering-mode";
  readonly onModeChange: (mode: RenderingMode) => void;
}

export type TopNavOptionItem =
  | TopNavRenderingModeOptionItem
  | TopNavToggleOptionItem;

export interface TopNavOptionsMenuContentProps {
  readonly hotkeyBindings: Accessor<readonly HotkeyBinding[]>;
  readonly hotkeyPlatform: AppPlatform;
  readonly gameLoaded: Accessor<boolean>;
  readonly playerReady: Accessor<boolean>;
  readonly optionItems: Accessor<readonly TopNavOptionItem[]>;
  readonly walkSpeed: Accessor<string>;
  readonly setWalkSpeed: Setter<string>;
  readonly handleSetWalkSpeed: (walkSpeed: number) => void;
  readonly frameRate: Accessor<string>;
  readonly setFrameRate: Setter<string>;
  readonly handleSetFrameRate: (frameRate: number) => void;
  readonly customName: Accessor<string>;
  readonly customNameConfigured: Accessor<boolean>;
  readonly setCustomName: Setter<string>;
  readonly handleSetCustomName: () => void;
  readonly handleResetCustomName: () => void;
  readonly customGuild: Accessor<string>;
  readonly customGuildConfigured: Accessor<boolean>;
  readonly setCustomGuild: Setter<string>;
  readonly handleSetCustomGuild: () => void;
  readonly handleResetCustomGuild: () => void;
  readonly handleReloadMap: () => void;
  readonly handleSetSpawnPoint: () => void;
}

export interface TopNavProps extends TopNavOptionsMenuContentProps {
  readonly openMenu: Accessor<GameTopNavMenu | null>;
  readonly setOpenMenu: Setter<GameTopNavMenu | null>;
  readonly autoAttackEnabled: Accessor<boolean>;
  readonly autoAttackProfileLabel: Accessor<string>;
  readonly autoAttackConfiguredProfileLabel: Accessor<string>;
  readonly autoAttackLastError: Accessor<string>;
  readonly autoAttackWarnings: Accessor<readonly string[]>;
  readonly autoAttackTargetPriority: Accessor<string>;
  readonly setAutoAttackTargetPriority: Setter<string>;
  readonly combatProfiles: Accessor<readonly TopNavCombatProfile[]>;
  readonly selectedAutoAttackProfileId: Accessor<string>;
  readonly handleToggleAutoAttack: () => void;
  readonly handleSelectAutoAttackProfile: (selectedProfileId: string) => void;
  readonly scriptLoaded: Accessor<boolean>;
  readonly scriptRunning: Accessor<boolean>;
  readonly scriptTogglePending: Accessor<boolean>;
  readonly scriptOptionsReady: Accessor<boolean>;
  readonly openScripts: () => void;
  readonly toggleScript: () => void | Promise<void>;
  readonly autoZoneEnabled: Accessor<boolean>;
  readonly autoZoneMap: Accessor<AutoZoneSupportedMap | undefined>;
  readonly handleToggleAutoZone: () => void;
  readonly handleSelectAutoZoneMap: (
    map: AutoZoneSupportedMap | undefined,
  ) => void;
  readonly autoReloginEnabled: Accessor<boolean>;
  readonly autoReloginCaptured: Accessor<boolean>;
  readonly autoReloginAttempting: Accessor<boolean>;
  readonly autoReloginWaitingDelay: Accessor<boolean>;
  readonly autoReloginToggling: Accessor<boolean>;
  readonly autoReloginDelaySeconds: Accessor<string>;
  readonly setAutoReloginDelaySeconds: Setter<string>;
  readonly autoReloginServer: Accessor<string>;
  readonly autoReloginServers: Accessor<readonly string[]>;
  readonly autoReloginLastError: Accessor<string>;
  readonly autoReloginAttemptsRemaining: Accessor<number | null>;
  readonly handleToggleAutoRelogin: () => void;
  readonly handleRefreshAutoReloginServers: () => void;
  readonly handleSelectAutoReloginServer: (serverName: string) => void;
  readonly handleSetAutoReloginDelay: () => void;
  readonly cells: Accessor<readonly string[]>;
  readonly pads: Accessor<readonly string[]>;
  readonly validPads: Accessor<readonly string[]>;
  readonly selectedCell: Accessor<string>;
  readonly selectedPad: Accessor<string>;
  readonly travelBusy: Accessor<boolean>;
  readonly handleRefreshTravelOptions: () => void;
  readonly handleSelectCell: (cell: string) => void;
  readonly handleSelectPad: (pad: string) => void;
  readonly handleOpenBank: () => void;
  readonly handleOpenWindow: (id: WindowId) => void;
}

const gameWindowItems: readonly {
  readonly id: WindowId;
  readonly label: string;
}[] = [
  { id: "combat-profiles", label: "Combat Profiles" },
  { id: "environment", label: "Environment" },
  { id: "follower", label: "Follower" },
  { id: "loader-grabber", label: "Loader/Grabber" },
  { id: "packets", label: "Packets" },
];

export const topNavOptionCommandIds: Partial<
  Record<SettingsCommandId, string>
> = {
  toggleInfiniteRange: "infinite-range",
  toggleProvokeCell: "provoke-cell",
  toggleEnemyMagnet: "enemy-magnet",
  toggleHidePlayers: "hide-players",
  toggleSkipCutscenes: "skip-cutscenes",
  toggleAntiCounter: "anti-counter",
  toggleAnimations: "animations",
  toggleCollisions: "collisions",
  toggleDeathAds: "death-ads",
};

const renderingModeOptions: readonly {
  readonly commandId?: SettingsCommandId;
  readonly label: string;
  readonly value: RenderingMode;
}[] = [
  { label: "Full", value: "full" },
  {
    commandId: "toggleInterfaceOnlyRendering",
    label: "Interface Only",
    value: "interface-only",
  },
  {
    commandId: "toggleMinimalRendering",
    label: "Minimal",
    value: "minimal",
  },
];

const commandIdsByOptionId = new Map<string, SettingsCommandId>(
  Object.entries(topNavOptionCommandIds).map(([commandId, optionId]) => [
    optionId,
    commandId as SettingsCommandId,
  ]),
);

export const windowCommandIds: Partial<Record<WindowId, SettingsCommandId>> = {
  environment: "openEnvironment",
  "loader-grabber": "openLoaderGrabber",
  follower: "openFollower",
  packets: "openPackets",
};

const commandHotkey = (
  bindings: readonly HotkeyBinding[],
  id: SettingsCommandId,
): string => readHotkeyBinding(bindings, id);

const formatOptionalHotkeyDisplay = (
  value: string,
  platform: AppPlatform,
): string => (value === "" ? "" : formatHotkeyDisplay(value, platform, ""));

const formatOptionalAriaKeyshortcuts = (
  value: string,
  platform: AppPlatform,
): string | undefined =>
  value === ""
    ? undefined
    : value
        .split("+")
        .map((part) =>
          part === "Mod" ? (platform === "mac" ? "Meta" : "Control") : part,
        )
        .join("+");

const renderingModeLabel = (mode: RenderingMode): string =>
  renderingModeOptions.find((option) => option.value === mode)?.label ?? mode;

const optionHotkey = (
  bindings: readonly HotkeyBinding[],
  optionId: string,
): string => {
  const commandId = commandIdsByOptionId.get(optionId);
  return commandId ? commandHotkey(bindings, commandId) : "";
};

const windowHotkey = (
  bindings: readonly HotkeyBinding[],
  id: WindowId,
): string => {
  const commandId = windowCommandIds[id];
  return commandId ? commandHotkey(bindings, commandId) : "";
};

const getAutoZoneMapLabel = (map: AutoZoneSupportedMap | undefined): string =>
  map === undefined
    ? ""
    : (AUTO_ZONE_MAP_OPTIONS.find((option) => option.value === map)?.label ??
      map);

const MenuAutofocusAnchor = (): JSX.Element => (
  <span
    aria-hidden="true"
    class="game-menu__autofocus-anchor"
    data-autofocus=""
    tabIndex={-1}
  />
);

const DEFAULT_WALK_SPEED = 8;
const DEFAULT_FRAME_RATE = 24;

function ResetCustomValueButton(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <Button
      aria-label={props.label}
      class="game-menu__field-reset"
      disabled={props.disabled}
      size="icon-xs"
      type="button"
      variant="ghost"
      onClick={props.onClick}
    >
      <Icon icon="rotate_ccw" size="sm" />
    </Button>
  );
}

function MenuNumberChip(props: {
  readonly disabled: boolean;
  readonly inputId: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onCommit: (value: number) => void;
  readonly resetValue: number;
  readonly setValue: Setter<string>;
  readonly value: Accessor<string>;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [draftValue, setDraftValue] = createSignal(props.value());
  let dragPointerId: number | undefined;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartValue = 0;
  let dragValue = 0;

  const clampValue = (nextValue: number): number =>
    Math.max(props.min, Math.min(props.max, Math.round(nextValue)));

  const value = (): number => {
    const parsed = Number(props.value());
    return Number.isFinite(parsed) ? clampValue(parsed) : props.resetValue;
  };

  createEffect(() => {
    const externalValue = String(value());
    if (!editing()) setDraftValue(externalValue);
  });

  const commit = (nextValue: number): void => {
    const currentValue = value();
    props.setValue(String(nextValue));
    setDraftValue(String(nextValue));
    if (nextValue !== currentValue) props.onCommit(nextValue);
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setDraftValue(String(value()));
  };

  const commitEdit = (): void => {
    if (!editing()) return;

    const parsed = Number(draftValue());
    if (!Number.isFinite(parsed) || draftValue().trim() === "") {
      cancelEdit();
      return;
    }

    const nextValue = clampValue(parsed);
    setEditing(false);
    commit(nextValue);
  };

  const resetDrag = (): void => {
    dragPointerId = undefined;
    setDragging(false);
  };

  const handlePointerDown: JSX.EventHandler<HTMLInputElement, PointerEvent> = (
    event,
  ) => {
    if (props.disabled || event.button !== 0) return;

    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartValue = value();
    dragValue = dragStartValue;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove: JSX.EventHandler<HTMLInputElement, PointerEvent> = (
    event,
  ) => {
    if (event.pointerId !== dragPointerId) return;

    const deltaX = event.clientX - dragStartX;
    const deltaY = event.clientY - dragStartY;
    if (
      !dragging() &&
      (Math.abs(deltaX) < 4 || Math.abs(deltaX) <= Math.abs(deltaY))
    ) {
      return;
    }

    event.preventDefault();
    if (!dragging()) setDragging(true);

    const nextValue = clampValue(dragStartValue + deltaX / 4);
    dragValue = nextValue;
    setDraftValue(String(nextValue));
  };

  const handlePointerUp: JSX.EventHandler<HTMLInputElement, PointerEvent> = (
    event,
  ) => {
    if (event.pointerId !== dragPointerId) return;

    const shouldCommit = dragging();
    const nextValue = dragValue;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resetDrag();

    if (!shouldCommit) return;
    event.preventDefault();
    commit(nextValue);
    event.currentTarget.select();
  };

  const handlePointerCancel: JSX.EventHandler<
    HTMLInputElement,
    PointerEvent
  > = (event) => {
    if (event.pointerId !== dragPointerId) return;

    resetDrag();
    setDraftValue(String(value()));
  };

  return (
    <div
      class="game-menu__number-chip"
      data-disabled={props.disabled ? "" : undefined}
    >
      <Label class="game-menu__number-chip-label" for={props.inputId}>
        {props.label}
      </Label>
      <span class="game-menu__number-chip-controls">
        <Button
          aria-label={`Restore ${props.label}`}
          disabled={props.disabled || value() === props.resetValue}
          size="icon-xs"
          title={`Restore ${props.label}`}
          type="button"
          variant="ghost"
          onClick={() => commit(props.resetValue)}
        >
          <Icon aria-hidden="true" icon="rotate_ccw" size="sm" />
        </Button>
        <Input
          aria-label={props.label}
          class="game-menu__number-chip-input"
          data-dragging={dragging() ? "" : undefined}
          disabled={props.disabled}
          id={props.inputId}
          inputMode="numeric"
          title={
            props.disabled
              ? undefined
              : `Drag to adjust ${props.label.toLowerCase()}, or select to type`
          }
          type="text"
          unstyled
          value={draftValue()}
          onBlur={commitEdit}
          onFocus={(event) => {
            setDraftValue(String(value()));
            setEditing(true);
            event.currentTarget.select();
          }}
          onInput={(event) => setDraftValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelEdit();
              event.currentTarget.blur();
              return;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commitEdit();
              event.currentTarget.blur();
              return;
            }

            if (event.key !== "Tab") event.stopPropagation();
          }}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </span>
    </div>
  );
}

const stopMenuInputKeyPropagation: JSX.EventHandler<
  HTMLInputElement,
  KeyboardEvent
> = (event) => {
  if (event.key !== "Escape" && event.key !== "Tab") {
    event.stopPropagation();
  }
};

const commitMenuInputOnEnter =
  (commit: () => void): JSX.EventHandler<HTMLInputElement, KeyboardEvent> =>
  (event) => {
    stopMenuInputKeyPropagation(event);
    if (event.key !== "Enter") return;

    event.preventDefault();
    commit();
  };

const combatProfileClassNames = (
  profile: TopNavCombatProfile,
): readonly string[] => profile.classNames ?? [];

const combatProfileClassSummary = (profile: TopNavCombatProfile): string => {
  const classNames = combatProfileClassNames(profile);
  if (classNames.length === 0) {
    return "Any";
  }

  return classNames.length === 1
    ? classNames[0]!
    : `${classNames.length} classes`;
};

const combatProfileTooltip = (
  profile: TopNavCombatProfile,
  group?: string,
): string => {
  if (group !== undefined) return `${profile.label} - ${group}`;
  const classNames = combatProfileClassNames(profile);
  return `${profile.label} - ${classNames.length === 0 ? "Any class" : classNames.join(", ")}`;
};

type TopNavMenuTriggerProps = Omit<ButtonProps, "as" | "size" | "type"> & {
  readonly expanded?: boolean;
};

function TopNavMenuTrigger(props: TopNavMenuTriggerProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "children",
    "class",
    "expanded",
    "variant",
  ]);

  return (
    <MenuTrigger
      asChild={(triggerProps) => (
        <Button
          {...(triggerProps({
            ...rest,
            children: local.children,
            class: cn("game-topnav__trigger", local.class),
            "data-expanded": local.expanded ? "" : undefined,
            size: "sm",
            type: "button",
            variant: local.variant ?? "ghost",
          } as ButtonProps) as ButtonProps)}
        />
      )}
    />
  );
}

type GameMenuPortalProps = {
  readonly portalMount: Accessor<Node | undefined>;
};

function GameMenuContent(
  props: MenuContentProps & GameMenuPortalProps,
): JSX.Element {
  const [local, rest] = splitProps(props, ["portalMount"]);

  return (
    <Show when={local.portalMount()}>
      {(portalMount) => (
        <Portal mount={portalMount()}>
          <MenuContent {...rest} portal={false} />
        </Portal>
      )}
    </Show>
  );
}

function GameMenuSubContent(
  props: MenuSubContentProps & GameMenuPortalProps,
): JSX.Element {
  const [local, rest] = splitProps(props, ["portalMount"]);

  return (
    <Show when={local.portalMount()}>
      {(portalMount) => (
        <Portal mount={portalMount()}>
          <MenuSubContent {...rest} portal={false} />
        </Portal>
      )}
    </Show>
  );
}

function RenderingModeControl(props: {
  readonly hotkeyBindings: Accessor<readonly HotkeyBinding[]>;
  readonly hotkeyPlatform: AppPlatform;
  readonly option: Accessor<TopNavRenderingModeOptionItem>;
}): JSX.Element {
  const handleValueChange = (details: { value: string }) => {
    const current = props.option();
    if (current.disabled === true || current.pending === true) return;

    const selected = renderingModeOptions.find(
      (candidate) => candidate.value === details.value,
    );
    if (selected !== undefined) current.onModeChange(selected.value);
  };

  return (
    <MenuRadioGroup
      aria-label={props.option().label}
      class="game-menu__rendering-modes"
      value={props.option().mode}
      onValueChange={handleValueChange}
    >
      <For each={renderingModeOptions}>
        {(mode) => {
          const hotkey = () =>
            mode.commandId === undefined
              ? ""
              : commandHotkey(props.hotkeyBindings(), mode.commandId);
          const shortcut = () =>
            formatOptionalHotkeyDisplay(hotkey(), props.hotkeyPlatform);

          return (
            <MenuRadioItem
              aria-keyshortcuts={formatOptionalAriaKeyshortcuts(
                hotkey(),
                props.hotkeyPlatform,
              )}
              class="game-menu__item game-menu__rendering-mode"
              closeOnSelect={false}
              disabled={
                props.option().disabled === true ||
                props.option().pending === true
              }
              value={mode.value}
            >
              <span class="game-menu__rendering-mode-label">{mode.label}</span>
              <Show when={shortcut()}>
                {(displayShortcut) => (
                  <Kbd aria-hidden="true">{displayShortcut()}</Kbd>
                )}
              </Show>
            </MenuRadioItem>
          );
        }}
      </For>
    </MenuRadioGroup>
  );
}

type TopNavOptionsMenuPage = "gameplay" | "rendering-mode";
type TopNavOptionsInputMode = "keyboard" | "pointer";

// Keep this in sync with `.game-menu--rendering-mode` in style.css.
const RENDERING_MODE_SUBMENU_WIDTH_REM = 16;
const FLOATING_MENU_GUTTER_PX = 4;

interface TopNavOptionsMenuContentInternalProps
  extends TopNavOptionsMenuContentProps, GameMenuPortalProps {
  readonly page: Accessor<TopNavOptionsMenuPage>;
  readonly sideSubmenuAvailable: Accessor<boolean>;
  readonly openRenderingModePage: (mode: RenderingMode) => void;
  readonly closeRenderingModePage: () => void;
}

export function TopNavOptionsMenuContent(
  props: TopNavOptionsMenuContentInternalProps,
): JSX.Element {
  const gameInteractionDisabled = () =>
    !props.gameLoaded() || !props.playerReady();
  const renderingModeOption = createMemo(() =>
    props
      .optionItems()
      .find(
        (option): option is TopNavRenderingModeOptionItem =>
          option.type === "rendering-mode",
      ),
  );
  const optionIds = createMemo(() =>
    props.optionItems().map((option) => option.id),
  );

  const renderToggleOption = (
    option: Accessor<TopNavToggleOptionItem>,
  ): JSX.Element => {
    const hotkey = () => optionHotkey(props.hotkeyBindings(), option().id);
    const shortcut = () =>
      formatOptionalHotkeyDisplay(hotkey(), props.hotkeyPlatform);

    return (
      <MenuCheckboxItem
        aria-keyshortcuts={formatOptionalAriaKeyshortcuts(
          hotkey(),
          props.hotkeyPlatform,
        )}
        checked={option().checked}
        class="game-menu__item game-menu__option-switch game-menu__switch-item"
        closeOnSelect={false}
        disabled={option().disabled}
        onCheckedChange={(checked) => option().onCheckedChange(checked)}
        value={option().id}
      >
        <span class="game-menu__option-switch-label">{option().label}</span>
        <span class="game-menu__option-switch-controls">
          <Show when={shortcut()}>
            {(displayShortcut) => (
              <Kbd aria-hidden="true" class="game-menu__option-switch-shortcut">
                {displayShortcut()}
              </Kbd>
            )}
          </Show>
          <span
            aria-hidden="true"
            class="game-menu__switch-visual"
            data-checked={option().checked ? "" : undefined}
          >
            <span class="game-menu__switch-thumb" />
          </span>
        </span>
      </MenuCheckboxItem>
    );
  };

  const renderRenderingModeOption = (
    option: Accessor<TopNavRenderingModeOptionItem>,
  ): JSX.Element => {
    const triggerContent = () => (
      <>
        <span class="game-menu__rendering-mode-trigger-label">
          {option().label}
        </span>
        <span class="game-menu__rendering-mode-trigger-value">
          {renderingModeLabel(option().mode)}
        </span>
      </>
    );

    return (
      <Show
        when={props.sideSubmenuAvailable()}
        fallback={
          <MenuItem
            aria-label={`${option().label}, ${renderingModeLabel(option().mode)}`}
            class="game-menu__item game-menu__rendering-mode-trigger"
            closeOnSelect={false}
            disabled={option().disabled === true || option().pending === true}
            onSelect={() => props.openRenderingModePage(option().mode)}
            value="rendering-mode"
          >
            {triggerContent()}
            <Icon
              aria-hidden="true"
              class="menu__sub-icon"
              icon="chevron_right"
            />
          </MenuItem>
        }
      >
        <MenuSub closeOnSelect={false}>
          <MenuSubTrigger
            aria-disabled={
              option().disabled === true || option().pending === true
                ? "true"
                : undefined
            }
            aria-label={`${option().label}, ${renderingModeLabel(option().mode)}`}
            class="game-menu__item game-menu__rendering-mode-trigger"
            data-disabled={
              option().disabled === true || option().pending === true
                ? ""
                : undefined
            }
          >
            {triggerContent()}
          </MenuSubTrigger>
          <GameMenuSubContent
            aria-label={option().label}
            class="game-menu game-menu--rendering-mode"
            portalMount={props.portalMount}
          >
            <RenderingModeControl
              hotkeyBindings={props.hotkeyBindings}
              hotkeyPlatform={props.hotkeyPlatform}
              option={option}
            />
          </GameMenuSubContent>
        </MenuSub>
      </Show>
    );
  };

  const renderGameplayOption = (id: string): JSX.Element => {
    const initialOption = props
      .optionItems()
      .find((option) => option.id === id);
    if (initialOption === undefined) return <></>;

    const currentOption = (): TopNavOptionItem =>
      props.optionItems().find((option) => option.id === id) ?? initialOption;

    if (initialOption.type === "toggle") {
      const toggleOption = (): TopNavToggleOptionItem => {
        const current = currentOption();
        return current.type === "toggle" ? current : initialOption;
      };
      return renderToggleOption(toggleOption);
    }

    const modeOption = (): TopNavRenderingModeOptionItem => {
      const current = currentOption();
      return current.type === "rendering-mode" ? current : initialOption;
    };
    return renderRenderingModeOption(modeOption);
  };

  return (
    <>
      <MenuAutofocusAnchor />
      <Show
        when={props.page() === "gameplay"}
        fallback={
          <div
            class="game-menu__options-content game-menu__options-content--rendering-mode"
            data-page="rendering-mode"
          >
            <MenuItem
              aria-label="Back to Gameplay options"
              class="game-menu__item game-menu__options-back"
              closeOnSelect={false}
              onSelect={props.closeRenderingModePage}
              value="rendering-mode-back"
            >
              <Icon
                aria-hidden="true"
                class="game-menu__options-back-icon"
                icon="arrow_left"
              />
              <span>Gameplay</span>
            </MenuItem>
            <MenuSeparator />
            <Show when={renderingModeOption()}>
              {(option) => (
                <MenuGroup class="game-menu__options-group">
                  <MenuLabel class="game-menu__options-heading">
                    {option().label}
                  </MenuLabel>
                  <RenderingModeControl
                    hotkeyBindings={props.hotkeyBindings}
                    hotkeyPlatform={props.hotkeyPlatform}
                    option={option}
                  />
                </MenuGroup>
              )}
            </Show>
          </div>
        }
      >
        <div class="game-menu__options-content" data-page="gameplay">
          <MenuGroup class="game-menu__options-group">
            <MenuLabel class="game-menu__options-heading">Gameplay</MenuLabel>
            <div class="game-options-grid">
              <For each={optionIds()}>{renderGameplayOption}</For>
            </div>
            <div
              aria-label="Gameplay values"
              class="game-menu__number-chips"
              role="group"
            >
              <MenuNumberChip
                disabled={gameInteractionDisabled()}
                inputId="game-walk-speed"
                label="Walk Speed"
                max={99}
                min={1}
                onCommit={props.handleSetWalkSpeed}
                resetValue={DEFAULT_WALK_SPEED}
                setValue={props.setWalkSpeed}
                value={props.walkSpeed}
              />
              <MenuNumberChip
                disabled={gameInteractionDisabled()}
                inputId="game-frame-rate"
                label="FPS"
                max={60}
                min={1}
                onCommit={props.handleSetFrameRate}
                resetValue={DEFAULT_FRAME_RATE}
                setValue={props.setFrameRate}
                value={props.frameRate}
              />
            </div>
          </MenuGroup>

          <MenuGroup class="game-menu__options-group">
            <MenuLabel class="game-menu__options-heading">Identity</MenuLabel>
            <div class="game-menu__identity-fields">
              <div
                class="game-menu__field game-menu__identity-field"
                data-disabled={gameInteractionDisabled() ? "" : undefined}
              >
                <span class="game-menu__field-heading">
                  <Label class="game-menu__field-label" for="game-custom-name">
                    Custom Name
                  </Label>
                  <span class="game-menu__field-actions">
                    <ResetCustomValueButton
                      disabled={
                        gameInteractionDisabled() ||
                        !props.customNameConfigured()
                      }
                      label="Reset custom name"
                      onClick={props.handleResetCustomName}
                    />
                  </span>
                </span>
                <Input
                  disabled={gameInteractionDisabled()}
                  fullWidth
                  id="game-custom-name"
                  size="sm"
                  value={props.customName()}
                  onBlur={props.handleSetCustomName}
                  onKeyDown={commitMenuInputOnEnter(props.handleSetCustomName)}
                  onInput={(event) =>
                    props.setCustomName(event.currentTarget.value)
                  }
                />
              </div>
              <div
                class="game-menu__field game-menu__identity-field"
                data-disabled={gameInteractionDisabled() ? "" : undefined}
              >
                <span class="game-menu__field-heading">
                  <Label class="game-menu__field-label" for="game-custom-guild">
                    Custom Guild
                  </Label>
                  <span class="game-menu__field-actions">
                    <ResetCustomValueButton
                      disabled={
                        gameInteractionDisabled() ||
                        !props.customGuildConfigured()
                      }
                      label="Reset custom guild"
                      onClick={props.handleResetCustomGuild}
                    />
                  </span>
                </span>
                <Input
                  disabled={gameInteractionDisabled()}
                  fullWidth
                  id="game-custom-guild"
                  size="sm"
                  value={props.customGuild()}
                  onBlur={props.handleSetCustomGuild}
                  onKeyDown={commitMenuInputOnEnter(props.handleSetCustomGuild)}
                  onInput={(event) =>
                    props.setCustomGuild(event.currentTarget.value)
                  }
                />
              </div>
            </div>
          </MenuGroup>

          <MenuGroup class="game-menu__options-group">
            <MenuLabel class="game-menu__options-heading">Actions</MenuLabel>
            <div class="game-menu__utility-actions">
              <MenuItem
                class="game-menu__item game-menu__utility-action"
                closeOnSelect={false}
                disabled={gameInteractionDisabled()}
                onSelect={props.handleReloadMap}
                value="reload-map"
              >
                Reload Map
              </MenuItem>
              <MenuItem
                class="game-menu__item game-menu__utility-action"
                closeOnSelect={false}
                disabled={gameInteractionDisabled()}
                onSelect={props.handleSetSpawnPoint}
                value="set-spawnpoint"
              >
                Set Spawnpoint
              </MenuItem>
            </div>
          </MenuGroup>
        </div>
      </Show>
    </>
  );
}

export function TopNav(props: TopNavProps): JSX.Element {
  let autoReloginMenuContent: HTMLDivElement | undefined;
  let optionsMenuContent: HTMLDivElement | undefined;
  let optionsMenuResizeObserver: ResizeObserver | undefined;
  let optionsMenuRootObserver: MutationObserver | undefined;
  let optionsMenuMeasurementFrame: number | undefined;
  let travelMenuContent: HTMLDivElement | undefined;
  const [menuPortalMount, setMenuPortalMount] = createSignal<HTMLDivElement>();
  const [groupCombatProfiles, setGroupCombatProfiles] = createSignal(false);
  const [selectedCombatProfileMenuValue, setSelectedCombatProfileMenuValue] =
    createSignal("");
  const [autoReloginServerMenuOpen, setAutoReloginServerMenuOpen] =
    createSignal(false);
  const [optionsMenuPage, setOptionsMenuPage] =
    createSignal<TopNavOptionsMenuPage>("gameplay");
  const [optionsSideSubmenuAvailable, setOptionsSideSubmenuAvailable] =
    createSignal(false);
  const [optionsHighlightedValue, setOptionsHighlightedValue] = createSignal<
    string | null
  >(null);
  const [optionsInputMode, setOptionsInputMode] =
    createSignal<TopNavOptionsInputMode>("pointer");
  const [travelHighlightedValue, setTravelHighlightedValue] = createSignal<
    string | null
  >(null);

  const renderingModeOption = (): TopNavRenderingModeOptionItem | undefined =>
    props
      .optionItems()
      .find(
        (option): option is TopNavRenderingModeOptionItem =>
          option.type === "rendering-mode",
      );

  const measureOptionsSubmenuSpace = (): void => {
    optionsMenuMeasurementFrame = undefined;
    if (props.openMenu() !== "options" || optionsMenuContent === undefined) {
      return;
    }

    const viewportWidth = document.documentElement.clientWidth;
    const parsedRootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const rootFontSize = Number.isFinite(parsedRootFontSize)
      ? parsedRootFontSize
      : 16;
    const submenuWidth = Math.min(
      RENDERING_MODE_SUBMENU_WIDTH_REM * rootFontSize,
      viewportWidth - rootFontSize * 0.5,
    );
    const requiredSideRoom = submenuWidth + FLOATING_MENU_GUTTER_PX;
    const bounds = optionsMenuContent.getBoundingClientRect();
    const leftRoom = bounds.left - FLOATING_MENU_GUTTER_PX;
    const rightRoom = viewportWidth - bounds.right - FLOATING_MENU_GUTTER_PX;

    setOptionsSideSubmenuAvailable(
      Math.max(leftRoom, rightRoom) >= requiredSideRoom,
    );
  };

  const scheduleOptionsSubmenuMeasurement = (): void => {
    if (optionsMenuMeasurementFrame !== undefined) {
      cancelAnimationFrame(optionsMenuMeasurementFrame);
    }
    optionsMenuMeasurementFrame = requestAnimationFrame(
      measureOptionsSubmenuSpace,
    );
  };

  const setOptionsMenuContentRef = (element: HTMLDivElement): void => {
    optionsMenuContent = element;
    optionsMenuResizeObserver?.disconnect();
    optionsMenuResizeObserver?.observe(element);
    scheduleOptionsSubmenuMeasurement();
  };

  const resetOptionsMenuNavigation = (): void => {
    setOptionsMenuPage("gameplay");
    setOptionsHighlightedValue(null);
    setOptionsInputMode("pointer");
    setOptionsSideSubmenuAvailable(false);
  };

  const openRenderingModePage = (mode: RenderingMode): void => {
    setOptionsMenuPage("rendering-mode");
    queueMicrotask(() => {
      if (
        props.openMenu() === "options" &&
        optionsMenuPage() === "rendering-mode"
      ) {
        setOptionsHighlightedValue(mode);
      }
    });
  };

  const closeRenderingModePage = (): void => {
    setOptionsMenuPage("gameplay");
    queueMicrotask(() => {
      if (props.openMenu() === "options" && optionsMenuPage() === "gameplay") {
        setOptionsHighlightedValue("rendering-mode");
      }
    });
  };

  const optionsMenuDirection = (): "ltr" | "rtl" => {
    const direction =
      optionsMenuContent === undefined
        ? document.documentElement.dir
        : getComputedStyle(optionsMenuContent).direction;
    return direction === "rtl" ? "rtl" : "ltr";
  };

  const handleOptionsMenuKeyDown: JSX.EventHandler<
    HTMLDivElement,
    KeyboardEvent
  > = (event) => {
    if (event.target === event.currentTarget) {
      setOptionsInputMode("keyboard");
    }

    const direction = optionsMenuDirection();
    const forwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backwardKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";

    if (optionsMenuPage() === "rendering-mode" && event.key === backwardKey) {
      event.preventDefault();
      event.stopPropagation();
      closeRenderingModePage();
      return;
    }

    if (
      optionsMenuPage() !== "gameplay" ||
      optionsSideSubmenuAvailable() ||
      optionsHighlightedValue() !== "rendering-mode" ||
      event.key !== forwardKey
    ) {
      return;
    }

    const option = renderingModeOption();
    if (
      option === undefined ||
      option.disabled === true ||
      option.pending === true
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openRenderingModePage(option.mode);
  };

  onMount(() => {
    optionsMenuResizeObserver = new ResizeObserver(
      scheduleOptionsSubmenuMeasurement,
    );
    if (optionsMenuContent !== undefined) {
      optionsMenuResizeObserver.observe(optionsMenuContent);
    }

    optionsMenuRootObserver = new MutationObserver(
      scheduleOptionsSubmenuMeasurement,
    );
    optionsMenuRootObserver.observe(document.documentElement, {
      attributes: true,
    });
    window.addEventListener("resize", scheduleOptionsSubmenuMeasurement);
  });

  onCleanup(() => {
    if (optionsMenuMeasurementFrame !== undefined) {
      cancelAnimationFrame(optionsMenuMeasurementFrame);
    }
    optionsMenuResizeObserver?.disconnect();
    optionsMenuRootObserver?.disconnect();
    window.removeEventListener("resize", scheduleOptionsSubmenuMeasurement);
  });

  createEffect(() => {
    if (props.openMenu() === "options") {
      scheduleOptionsSubmenuMeasurement();
      return;
    }
    resetOptionsMenuNavigation();
  });

  const handleToggleScriptClick = (): void => {
    void props.toggleScript();
  };
  const scriptToggleDisabled = (): boolean =>
    !props.scriptLoaded() ||
    props.scriptTogglePending() ||
    (!props.scriptRunning() && !props.scriptOptionsReady());

  const autoReloginNeedsAttention = (): boolean =>
    props.autoReloginLastError() !== "";
  const autoReloginAwaitingSession = (): boolean =>
    props.autoReloginEnabled() && !props.autoReloginCaptured();

  const autoReloginAttemptsRemainingLabel = (): string => {
    const remaining = props.autoReloginAttemptsRemaining();
    if (remaining === null) return "";
    if (remaining <= 0) return "final attempt";
    return `${remaining} ${remaining === 1 ? "retry" : "retries"} left`;
  };

  const autoReloginTriggerLabel = (): string => {
    if (props.autoReloginToggling()) {
      return props.autoReloginEnabled()
        ? "Auto Relogin enabling"
        : "Auto Relogin disabling";
    }

    if (props.autoReloginAttempting()) {
      const remaining = autoReloginAttemptsRemainingLabel();
      return remaining === ""
        ? "Auto Relogin reconnecting"
        : `Auto Relogin reconnecting (${remaining})`;
    }

    if (props.autoReloginWaitingDelay()) {
      return "Auto Relogin waiting before reconnect";
    }

    if (autoReloginAwaitingSession()) {
      return "Auto Relogin waiting for login";
    }

    const error = props.autoReloginLastError();
    return error === "" ? "Auto Relogin" : `Auto Relogin failed: ${error}`;
  };

  const autoReloginHasTerminalError = (): boolean =>
    autoReloginNeedsAttention() &&
    !props.autoReloginToggling() &&
    !props.autoReloginAttempting() &&
    !props.autoReloginWaitingDelay() &&
    !autoReloginAwaitingSession();

  const autoReloginActivity = (): "waiting" | "reconnecting" | undefined => {
    if (props.autoReloginToggling() || props.autoReloginAttempting()) {
      return "reconnecting";
    }

    return props.autoReloginWaitingDelay() || autoReloginAwaitingSession()
      ? "waiting"
      : undefined;
  };

  const autoReloginMenuStatus = (): string => {
    if (props.autoReloginToggling()) {
      return props.autoReloginEnabled() ? "Enabling" : "Disabling";
    }

    let status = "";
    if (props.autoReloginWaitingDelay()) status = "Waiting to reconnect";
    else if (autoReloginAwaitingSession()) status = "Waiting for login";
    else if (props.autoReloginAttempting()) status = "Reconnecting";

    if (status !== "") {
      const attempts = autoReloginAttemptsRemainingLabel();
      return attempts === "" ? status : `${status} (${attempts})`;
    }

    return props.autoReloginLastError();
  };

  const autoAttackIssues = (): readonly string[] => {
    const error = props.autoAttackLastError();
    return error === "" ? props.autoAttackWarnings() : [error];
  };

  const autoAttackTriggerLabel = (): string => {
    const profileLabel = autoAttackTriggerText();
    const error = props.autoAttackLastError();
    const warnings = props.autoAttackWarnings();
    let label: string;

    if (error !== "") {
      label = `Auto Attack failed: ${error}`;
    } else if (warnings.length > 0) {
      label = `Auto Attack warning: ${warnings.join(" ")}`;
    } else if (!props.autoAttackEnabled()) {
      label =
        profileLabel === ""
          ? "Auto Attack disabled"
          : `Auto Attack disabled: ${profileLabel}`;
    } else {
      label =
        profileLabel === ""
          ? "Auto Attack enabled"
          : `Auto Attack enabled: ${profileLabel}`;
    }

    return label;
  };

  const autoAttackTriggerText = (): string =>
    props.autoAttackEnabled()
      ? props.autoAttackProfileLabel() ||
        props.autoAttackConfiguredProfileLabel()
      : props.autoAttackConfiguredProfileLabel();

  const combatProfileMenuItems = createMemo(() =>
    buildCombatProfileOptions(
      props.combatProfiles(),
      groupCombatProfiles(),
      props.autoAttackEnabled(),
    ),
  );
  const autoAttackSelectionValue = createMemo(() =>
    resolveCombatProfileOptionValue(
      combatProfileMenuItems(),
      props.selectedAutoAttackProfileId(),
      selectedCombatProfileMenuValue(),
    ),
  );

  const autoAttackPrioritySummary = (): string => {
    const targetCount = props
      .autoAttackTargetPriority()
      .split(/[,;\n]+/u)
      .map((target) => target.trim())
      .filter((target) => target !== "").length;
    if (targetCount === 0) {
      return "None";
    }

    return `${targetCount} ${targetCount === 1 ? "target" : "targets"}`;
  };

  const handleAutoAttackSelectionChange = (details: { value: string }) => {
    if (props.autoAttackEnabled()) {
      return;
    }

    const item = combatProfileMenuItems().find(
      (item) => item.value === details.value,
    );
    if (item !== undefined) {
      setSelectedCombatProfileMenuValue(item.value);
      props.handleSelectAutoAttackProfile(item.id);
    }
  };

  const setMenuOpen =
    (menu: GameTopNavMenu) =>
    (details: { readonly open: boolean }): void => {
      props.setOpenMenu(details.open ? menu : null);
    };

  const setAutoReloginMenuOpen = (details: {
    readonly open: boolean;
  }): void => {
    if (details.open) {
      props.handleRefreshAutoReloginServers();
    } else {
      setAutoReloginServerMenuOpen(false);
    }
    props.setOpenMenu(details.open ? "relogin" : null);
  };

  const toggleMenu =
    (menu: GameTopNavMenu): JSX.EventHandler<HTMLButtonElement, MouseEvent> =>
    (event) => {
      event.preventDefault();
      props.setOpenMenu((current) => (current === menu ? null : menu));
    };

  const gameInteractionDisabled = () => !props.playerReady();

  const travelUnavailable = () => gameInteractionDisabled();

  const travelInteractionBlocked = () =>
    travelUnavailable() || props.travelBusy();

  const setTravelMenuOpen = (details: { readonly open: boolean }): void => {
    if (details.open && props.openMenu() !== "travel") {
      props.handleRefreshTravelOptions();
    }
    if (!details.open) {
      setTravelHighlightedValue(null);
    }
    props.setOpenMenu(details.open ? "travel" : null);
  };

  const toggleTravelMenu: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (
    event,
  ) => {
    event.preventDefault();
    if (travelInteractionBlocked()) {
      return;
    }

    setTravelMenuOpen({ open: props.openMenu() !== "travel" });
  };

  const isValidPad = (pad: string) =>
    props
      .validPads()
      .some((validPad) => validPad.toLowerCase() === pad.toLowerCase());

  type TravelColumn = "cell" | "pad";

  const travelColumnValues = (column: TravelColumn): readonly string[] =>
    column === "cell"
      ? props.cells().map((cell) => `cell:${cell}`)
      : props.pads().map((pad) => `pad:${pad}`);

  const travelHighlightedColumn = (): TravelColumn | null => {
    const value = travelHighlightedValue();
    if (value?.startsWith("cell:")) return "cell";
    if (value?.startsWith("pad:")) return "pad";
    return null;
  };

  const highlightTravelItem = (value: string | null): void => {
    setTravelHighlightedValue(value);
    if (value === null) return;

    const item = Array.from(
      travelMenuContent?.querySelectorAll<HTMLElement>(
        "[data-slot='menu-item']",
      ) ?? [],
    ).find((candidate) => candidate.dataset["value"] === value);
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const handleTravelMenuKeyDown: JSX.EventHandler<
    HTMLDivElement,
    KeyboardEvent
  > = (event) => {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Tab"
    ) {
      return;
    }

    if (event.key === "Tab") {
      const values = [
        ...travelColumnValues("cell"),
        ...travelColumnValues("pad"),
      ];
      if (values.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      const currentIndex = values.indexOf(travelHighlightedValue() ?? "");
      const nextIndex =
        currentIndex === -1
          ? event.shiftKey
            ? values.length - 1
            : 0
          : (currentIndex + (event.shiftKey ? -1 : 1) + values.length) %
            values.length;
      highlightTravelItem(values[nextIndex] ?? null);
      return;
    }

    const currentColumn = travelHighlightedColumn();
    const targetColumn =
      event.key === "ArrowLeft"
        ? "cell"
        : event.key === "ArrowRight"
          ? "pad"
          : (currentColumn ?? "cell");
    const targetValues = travelColumnValues(targetColumn);
    if (targetValues.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const currentValue = travelHighlightedValue();
      const currentIndex = targetValues.indexOf(currentValue ?? "");
      const nextIndex =
        currentIndex === -1
          ? event.key === "ArrowUp"
            ? targetValues.length - 1
            : 0
          : (currentIndex +
              (event.key === "ArrowUp" ? -1 : 1) +
              targetValues.length) %
            targetValues.length;
      highlightTravelItem(targetValues[nextIndex] ?? null);
      return;
    }

    if (currentColumn === targetColumn) {
      return;
    }

    const sourceValues =
      currentColumn === null ? [] : travelColumnValues(currentColumn);
    const sourceIndex = sourceValues.indexOf(travelHighlightedValue() ?? "");
    highlightTravelItem(
      targetValues[
        Math.min(Math.max(sourceIndex, 0), targetValues.length - 1)
      ] ?? null,
    );
  };

  const commitAutoReloginDelayOnEnter: JSX.EventHandler<
    HTMLInputElement,
    KeyboardEvent
  > = (event) => {
    stopMenuInputKeyPropagation(event);
    if (event.key !== "Enter") return;
    event.preventDefault();
    props.handleSetAutoReloginDelay();
  };

  const closeAutoReloginServerMenuToParent: JSX.EventHandler<
    HTMLDivElement,
    KeyboardEvent
  > = (event) => {
    if (event.key !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    setAutoReloginServerMenuOpen(false);
    autoReloginMenuContent?.focus({ preventScroll: true });
  };

  return (
    <div id="topnav-container" class="game-topnav-container">
      <div
        ref={(element) => setMenuPortalMount(element)}
        class="game-topnav__menu-portal"
      />
      <nav id="topnav" class="game-topnav" aria-label="Game controls">
        <div
          class="game-topnav__left"
          data-menu-open={
            props.openMenu() !== null && props.openMenu() !== "travel"
              ? ""
              : undefined
          }
        >
          <Menu
            open={props.openMenu() === "windows"}
            onOpenChange={setMenuOpen("windows")}
          >
            <TopNavMenuTrigger
              expanded={props.openMenu() === "windows"}
              onClick={toggleMenu("windows")}
            >
              Windows
            </TopNavMenuTrigger>
            <GameMenuContent
              class="game-menu game-menu--windows"
              portalMount={menuPortalMount}
            >
              <For each={gameWindowItems}>
                {(item, index) => (
                  <>
                    <Show when={index() === 1}>
                      <MenuSeparator />
                    </Show>
                    <MenuItem
                      class="game-menu__item"
                      onSelect={() => props.handleOpenWindow(item.id)}
                      value={item.id}
                    >
                      <span class="game-menu__item-label">{item.label}</span>
                      <Show
                        when={formatOptionalHotkeyDisplay(
                          windowHotkey(props.hotkeyBindings(), item.id),
                          props.hotkeyPlatform,
                        )}
                      >
                        {(shortcut) => <Kbd>{shortcut()}</Kbd>}
                      </Show>
                    </MenuItem>
                  </>
                )}
              </For>
            </GameMenuContent>
          </Menu>

          <Button
            class="game-topnav__trigger"
            onClick={() => props.openScripts()}
            size="sm"
            variant="ghost"
          >
            Scripts
          </Button>

          <Menu
            highlightedValue={optionsHighlightedValue()}
            open={props.openMenu() === "options"}
            onHighlightChange={(details) =>
              setOptionsHighlightedValue(details.highlightedValue)
            }
            onOpenChange={setMenuOpen("options")}
          >
            <TopNavMenuTrigger
              expanded={props.openMenu() === "options"}
              onClick={toggleMenu("options")}
              onKeyDown={() => setOptionsInputMode("keyboard")}
              onPointerDown={() => setOptionsInputMode("pointer")}
            >
              Options
            </TopNavMenuTrigger>
            <GameMenuContent
              ref={setOptionsMenuContentRef}
              class="game-menu game-menu--options"
              data-input-mode={optionsInputMode()}
              onKeyDown={handleOptionsMenuKeyDown}
              onPointerMove={() => setOptionsInputMode("pointer")}
              portalMount={menuPortalMount}
            >
              <TopNavOptionsMenuContent
                {...props}
                closeRenderingModePage={closeRenderingModePage}
                openRenderingModePage={openRenderingModePage}
                page={optionsMenuPage}
                portalMount={menuPortalMount}
                sideSubmenuAvailable={optionsSideSubmenuAvailable}
              />
            </GameMenuContent>
          </Menu>

          <Menu
            open={props.openMenu() === "autozone"}
            onOpenChange={setMenuOpen("autozone")}
          >
            <TopNavMenuTrigger
              class="game-topnav__trigger--autozone"
              expanded={props.openMenu() === "autozone"}
              onClick={toggleMenu("autozone")}
              title={
                props.autoZoneEnabled() && props.autoZoneMap()
                  ? `Auto Zone: ${getAutoZoneMapLabel(props.autoZoneMap())}`
                  : undefined
              }
            >
              <span>Auto Zone</span>
              <Show when={props.autoZoneEnabled() && props.autoZoneMap()}>
                <span class="game-topnav__trigger-detail">
                  {props.autoZoneMap()}
                </span>
              </Show>
            </TopNavMenuTrigger>
            <GameMenuContent
              class="game-menu game-menu--autozone"
              portalMount={menuPortalMount}
            >
              <MenuAutofocusAnchor />
              <MenuCheckboxItem
                checked={props.autoZoneEnabled()}
                class="game-menu__item game-menu__switch-item"
                closeOnSelect={false}
                onClick={props.handleToggleAutoZone}
                value="toggle-autozone"
              >
                <span class="game-menu__item-label">Auto Zone</span>
                <span
                  aria-hidden="true"
                  class="game-menu__switch-visual"
                  data-checked={props.autoZoneEnabled() ? "" : undefined}
                >
                  <span class="game-menu__switch-thumb" />
                </span>
              </MenuCheckboxItem>
              <MenuSub closeOnSelect={false}>
                <MenuSubTrigger class="game-menu__item game-menu__server-trigger">
                  <span class="game-menu__item-label">Map</span>
                  <span class="game-menu__item-value">
                    {getAutoZoneMapLabel(props.autoZoneMap()) || "None"}
                  </span>
                </MenuSubTrigger>
                <GameMenuSubContent
                  class="game-menu game-menu--compact game-menu--autozone-maps"
                  portalMount={menuPortalMount}
                >
                  <For each={AUTO_ZONE_MAP_OPTIONS}>
                    {(option) => (
                      <MenuCheckboxItem
                        checked={props.autoZoneMap() === option.value}
                        class="game-menu__item"
                        closeOnSelect={false}
                        onClick={() =>
                          props.handleSelectAutoZoneMap(
                            option.value as AutoZoneSupportedMap,
                          )
                        }
                        value={option.value}
                      >
                        <span class="game-menu__item-label">
                          {option.label}
                        </span>
                      </MenuCheckboxItem>
                    )}
                  </For>
                </GameMenuSubContent>
              </MenuSub>
            </GameMenuContent>
          </Menu>

          <Menu
            open={props.openMenu() === "relogin"}
            onOpenChange={setAutoReloginMenuOpen}
          >
            <TopNavMenuTrigger
              aria-label={autoReloginTriggerLabel()}
              class={cn(
                "game-topnav__trigger--relogin",
                autoReloginHasTerminalError() && "game-topnav__trigger--alert",
              )}
              expanded={props.openMenu() === "relogin"}
              title={
                autoReloginTriggerLabel() === "Auto Relogin"
                  ? props.autoReloginEnabled() && props.autoReloginServer()
                    ? `Auto Relogin: ${props.autoReloginServer()}`
                    : undefined
                  : autoReloginTriggerLabel()
              }
            >
              <span
                aria-hidden="true"
                class="game-topnav__relogin-indicator"
                data-phase={autoReloginActivity()}
              >
                <Show when={autoReloginActivity()}>
                  {(activity) => (
                    <Icon
                      class="game-topnav__relogin-indicator-icon"
                      icon={
                        activity() === "waiting" ? "clock" : "loader_circle"
                      }
                      size="xs"
                    />
                  )}
                </Show>
              </span>
              <span class="game-topnav__relogin-label">Auto Relogin</span>
              <Show
                when={props.autoReloginEnabled() && props.autoReloginServer()}
              >
                <span class="game-topnav__trigger-detail">
                  {props.autoReloginServer()}
                </span>
              </Show>
            </TopNavMenuTrigger>
            <GameMenuContent
              ref={(element) => {
                autoReloginMenuContent = element;
              }}
              class="game-menu game-menu--relogin"
              portalMount={menuPortalMount}
            >
              <MenuAutofocusAnchor />
              <Show when={autoReloginMenuStatus()}>
                {(status) => (
                  <>
                    <div
                      class="game-menu__status game-menu__status--relogin"
                      classList={{
                        "game-menu__error": autoReloginHasTerminalError(),
                      }}
                      role="status"
                      title={
                        autoReloginHasTerminalError() ? status() : undefined
                      }
                    >
                      {status()}
                    </div>
                    <MenuSeparator />
                  </>
                )}
              </Show>
              <MenuCheckboxItem
                checked={props.autoReloginEnabled()}
                class="game-menu__item game-menu__switch-item"
                closeOnSelect={false}
                disabled={props.autoReloginToggling()}
                onClick={props.handleToggleAutoRelogin}
                value="toggle-autorelogin"
              >
                <span class="game-menu__item-label">Auto Relogin</span>
                <span
                  aria-hidden="true"
                  class="game-menu__switch-visual"
                  data-checked={props.autoReloginEnabled() ? "" : undefined}
                >
                  <span class="game-menu__switch-thumb" />
                </span>
              </MenuCheckboxItem>
              <MenuSub
                id="autorelogin-server-menu"
                open={autoReloginServerMenuOpen()}
                onOpenChange={(details) =>
                  setAutoReloginServerMenuOpen(details.open)
                }
                closeOnSelect={false}
              >
                <MenuSubTrigger class="game-menu__item game-menu__server-trigger">
                  <span class="game-menu__item-label">Server</span>
                  <span class="game-menu__item-value">
                    {props.autoReloginServer() || "None"}
                  </span>
                </MenuSubTrigger>
                <GameMenuSubContent
                  class="game-menu game-menu--compact game-menu--relogin-servers"
                  onKeyDownCapture={closeAutoReloginServerMenuToParent}
                  portalMount={menuPortalMount}
                >
                  <Show
                    when={props.autoReloginServers().length > 0}
                    fallback={
                      <MenuItem
                        class="game-menu__item"
                        disabled
                        value="no-servers"
                      >
                        No servers found
                      </MenuItem>
                    }
                  >
                    <For each={props.autoReloginServers()}>
                      {(serverName) => (
                        <MenuCheckboxItem
                          checked={props.autoReloginServer() === serverName}
                          class="game-menu__item"
                          closeOnSelect={false}
                          onClick={() =>
                            props.handleSelectAutoReloginServer(serverName)
                          }
                          value={serverName}
                        >
                          <span class="game-menu__item-label">
                            {serverName}
                          </span>
                        </MenuCheckboxItem>
                      )}
                    </For>
                  </Show>
                </GameMenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <div class="game-menu__fields game-menu__fields--single-row">
                <Label class="game-menu__field game-menu__field--inline game-menu__field--wide game-menu__field--menu-inset">
                  <span>Delay</span>
                  <div class="game-menu__delay-control">
                    <Input
                      class="game-menu__delay-input"
                      inputMode="decimal"
                      max="300"
                      min="0"
                      size="sm"
                      step="1"
                      type="number"
                      value={props.autoReloginDelaySeconds()}
                      onBlur={props.handleSetAutoReloginDelay}
                      onKeyDown={commitAutoReloginDelayOnEnter}
                      onInput={(event) =>
                        props.setAutoReloginDelaySeconds(
                          event.currentTarget.value,
                        )
                      }
                    />
                    <span class="game-menu__delay-unit">sec</span>
                  </div>
                </Label>
              </div>
            </GameMenuContent>
          </Menu>

          <Button
            class={cn(
              "game-topnav__button",
              props.scriptRunning() && "game-topnav__button--danger",
              props.scriptLoaded() &&
                !props.scriptRunning() &&
                "game-topnav__button--success",
            )}
            disabled={scriptToggleDisabled()}
            onClick={handleToggleScriptClick}
            size="sm"
            variant="ghost"
          >
            {props.scriptRunning() ? "Stop" : "Start"}
          </Button>
        </div>

        <div
          class="game-topnav__right"
          data-menu-open={
            props.openMenu() === "combat" || props.openMenu() === "travel"
              ? ""
              : undefined
          }
        >
          <Menu
            open={props.openMenu() === "combat"}
            onOpenChange={setMenuOpen("combat")}
          >
            <TopNavMenuTrigger
              aria-label={autoAttackTriggerLabel()}
              aria-pressed={props.autoAttackEnabled()}
              class={cn(
                "game-topnav__combat-trigger",
                props.autoAttackLastError() !== "" &&
                  "game-topnav__trigger--alert",
                props.autoAttackLastError() === "" &&
                  props.autoAttackWarnings().length > 0 &&
                  "game-topnav__trigger--warning",
              )}
              data-enabled={props.autoAttackEnabled() ? "" : undefined}
              disabled={gameInteractionDisabled()}
              expanded={props.openMenu() === "combat"}
              onClick={toggleMenu("combat")}
              title={autoAttackTriggerLabel()}
            >
              <Show when={autoAttackIssues().length > 0}>
                <Icon
                  aria-hidden="true"
                  class="game-topnav__combat-issue-icon"
                  icon="circle_alert"
                  size="xs"
                />
              </Show>
              <span class="game-topnav__combat-label">
                {autoAttackTriggerText()}
              </span>
              <Icon
                icon="chevron_down"
                aria-hidden="true"
                class="game-topnav__select-chevron"
              />
            </TopNavMenuTrigger>
            <GameMenuContent
              class="game-menu game-menu--combat"
              portalMount={menuPortalMount}
            >
              <MenuAutofocusAnchor />
              <Show when={autoAttackIssues().length > 0}>
                <For each={autoAttackIssues()}>
                  {(issue) => (
                    <div
                      class="game-menu__status game-menu__status--combat-issue"
                      classList={{
                        "game-menu__error": props.autoAttackLastError() !== "",
                        "game-menu__warning":
                          props.autoAttackLastError() === "",
                      }}
                      role="status"
                    >
                      <Icon icon="circle_alert" aria-hidden="true" />
                      <span>{issue}</span>
                    </div>
                  )}
                </For>
                <MenuSeparator />
              </Show>
              <MenuCheckboxItem
                checked={props.autoAttackEnabled()}
                class="game-menu__item game-menu__switch-item"
                closeOnSelect={false}
                disabled={gameInteractionDisabled()}
                onClick={props.handleToggleAutoAttack}
                value="toggle-auto-attack"
              >
                <span class="game-menu__item-label">Auto Attack</span>
                <span
                  aria-hidden="true"
                  class="game-menu__switch-visual"
                  data-checked={props.autoAttackEnabled() ? "" : undefined}
                >
                  <span class="game-menu__switch-thumb" />
                </span>
              </MenuCheckboxItem>
              <MenuSub closeOnSelect={false}>
                <MenuSubTrigger class="game-menu__item game-menu__sub-trigger">
                  <span class="game-menu__item-label">Priority</span>
                  <span class="game-menu__item-value">
                    {autoAttackPrioritySummary()}
                  </span>
                </MenuSubTrigger>
                <GameMenuSubContent
                  class="game-menu game-menu--combat-priority"
                  portalMount={menuPortalMount}
                >
                  <div class="game-menu__fields game-menu__fields--single-row">
                    <Label class="game-menu__field game-menu__field--wide">
                      <span>Targets</span>
                      <Input
                        class="game-menu__priority-input"
                        disabled={props.autoAttackEnabled()}
                        placeholder="id:1, Undead Warrior"
                        size="sm"
                        value={props.autoAttackTargetPriority()}
                        onKeyDown={stopMenuInputKeyPropagation}
                        onInput={(event) =>
                          props.setAutoAttackTargetPriority(
                            event.currentTarget.value,
                          )
                        }
                      />
                    </Label>
                  </div>
                </GameMenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <VirtualizedMenuRadioGroup
                class="game-menu__profile-list"
                groupBy={
                  groupCombatProfiles()
                    ? (profile) => profile.group ?? "Any class"
                    : undefined
                }
                header={
                  <MenuCheckboxItem
                    aria-label="Group by class"
                    checked={groupCombatProfiles()}
                    class="virtual-list__group-toggle"
                    closeOnSelect={false}
                    onCheckedChange={setGroupCombatProfiles}
                    title={
                      groupCombatProfiles()
                        ? "Show flat list"
                        : "Show grouped list"
                    }
                    value="group-combat-profiles"
                  >
                    <Icon icon="list_tree" aria-hidden="true" size="sm" />
                    <span>Group</span>
                  </MenuCheckboxItem>
                }
                items={combatProfileMenuItems()}
                searchable
                scrollToSelected
                value={autoAttackSelectionValue()}
                onValueChange={handleAutoAttackSelectionChange}
              >
                {(profile) => (
                  <MenuRadioItem
                    aria-label={combatProfileTooltip(profile, profile.group)}
                    class={cn(
                      "game-menu__item game-menu__profile-item",
                      groupCombatProfiles() &&
                        "game-menu__profile-item--grouped",
                    )}
                    closeOnSelect={false}
                    disabled={props.autoAttackEnabled()}
                    title={combatProfileTooltip(profile, profile.group)}
                    value={profile.value}
                  >
                    <span class="game-menu__item-label">{profile.label}</span>
                    <Show when={!groupCombatProfiles()}>
                      <span class="game-menu__item-value game-menu__profile-class">
                        {combatProfileClassSummary(profile)}
                      </span>
                    </Show>
                  </MenuRadioItem>
                )}
              </VirtualizedMenuRadioGroup>
              <MenuSeparator />
              <MenuItem
                class="game-menu__item"
                title="Open Combat Profiles"
                value="open-combat-profiles"
                onSelect={() => props.handleOpenWindow("combat-profiles")}
              >
                <span class="game-menu__item-label">Combat Profiles</span>
                <Icon icon="arrow_up_right" aria-hidden="true" size="sm" />
              </MenuItem>
            </GameMenuContent>
          </Menu>

          <Menu
            highlightedValue={travelHighlightedValue()}
            open={props.openMenu() === "travel"}
            onHighlightChange={(details) =>
              setTravelHighlightedValue(details.highlightedValue)
            }
            onOpenChange={setTravelMenuOpen}
          >
            <TopNavMenuTrigger
              aria-label={`Travel, cell ${props.selectedCell() || "unknown"}, pad ${props.selectedPad() || "unknown"}`}
              aria-busy={props.travelBusy() ? "true" : undefined}
              class="game-topnav__select-trigger game-topnav__select-trigger--travel"
              disabled={travelUnavailable()}
              expanded={props.openMenu() === "travel"}
              onClick={toggleTravelMenu}
              variant="secondary"
            >
              <span class="game-topnav__select-label game-topnav__travel-label">
                {props.selectedCell() || "Cell"}
              </span>
              <span aria-hidden="true" class="game-topnav__travel-divider" />
              <span class="game-topnav__trigger-detail game-topnav__travel-label">
                {props.selectedPad() || "Pad"}
              </span>
              <Icon
                icon="chevron_down"
                aria-hidden="true"
                class="game-topnav__select-chevron"
              />
            </TopNavMenuTrigger>
            <GameMenuContent
              ref={(element) => {
                travelMenuContent = element;
              }}
              class="game-menu game-menu--travel"
              onKeyDown={handleTravelMenuKeyDown}
              portalMount={menuPortalMount}
            >
              <div class="game-menu__travel-columns">
                <MenuGroup class="game-menu__travel-column">
                  <MenuLabel class="game-menu__travel-heading">Cell</MenuLabel>
                  <div class="game-menu__travel-options">
                    <Show
                      when={props.cells().length > 0}
                      fallback={
                        <MenuItem
                          class="game-menu__item"
                          disabled
                          value="cell:none"
                        >
                          No cells found
                        </MenuItem>
                      }
                    >
                      <For each={props.cells()}>
                        {(cell) => (
                          <MenuItem
                            class="game-menu__item"
                            onSelect={() => props.handleSelectCell(cell)}
                            value={`cell:${cell}`}
                          >
                            {cell}
                          </MenuItem>
                        )}
                      </For>
                    </Show>
                  </div>
                </MenuGroup>
                <MenuGroup class="game-menu__travel-column">
                  <MenuLabel class="game-menu__travel-heading">Pad</MenuLabel>
                  <div class="game-menu__travel-options">
                    <Show
                      when={props.pads().length > 0}
                      fallback={
                        <MenuItem
                          class="game-menu__item"
                          disabled
                          value="pad:none"
                        >
                          No pads found
                        </MenuItem>
                      }
                    >
                      <For each={props.pads()}>
                        {(pad) => (
                          <MenuItem
                            class={cn(
                              "game-menu__item game-menu__pad-option",
                              isValidPad(pad) && "game-menu__pad-option--valid",
                            )}
                            onSelect={() => props.handleSelectPad(pad)}
                            value={`pad:${pad}`}
                          >
                            <span class="game-menu__pad-name">{pad}</span>
                          </MenuItem>
                        )}
                      </For>
                    </Show>
                  </div>
                </MenuGroup>
              </div>
            </GameMenuContent>
          </Menu>

          <Button
            disabled={gameInteractionDisabled()}
            onClick={props.handleOpenBank}
            size="sm"
            variant="secondary"
          >
            Bank
          </Button>
        </div>
      </nav>
    </div>
  );
}
