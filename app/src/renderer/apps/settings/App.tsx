import {
  Icon,
  HelpTooltip,
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDescription,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ColorPicker,
  Input,
  Kbd,
  KbdGroup,
  Slider,
  SliderValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipIconButton,
  TooltipTrigger,
  type ButtonProps,
  type TooltipProps,
} from "@lucent/ui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js";
import {
  SETTING_COMMAND_CATEGORIES,
  SETTINGS_COMMANDS,
  formatHotkeyDisplay as displayHotkey,
  formatHotkeyDisplayParts as displayHotkeyParts,
  normalizeHotkeyBindingValue,
  readHotkeyBinding,
  type HotkeyBinding,
  type HotkeysPatch,
  type SettingsCommandCategory as CommandCategory,
  type SettingsCommandDefinition as CommandDefinition,
  type SettingsCommandId as GameCommandId,
} from "@lucent/core/hotkeys";
import { readHotkeyInputFromEvent } from "../../../shared/hotkeys";
import { hexToRgb, rgbEquals, rgbToHex } from "@lucent/core/appearance";
import {
  selectDesktopBridge,
  type AppPlatform,
} from "../../../shared/desktopBridge";
import {
  DEFAULT_APP_SETTINGS,
  THEME_TOKEN_NAMES,
  type AppSettings,
  type AppearancePatch,
  type MotionMode,
  type PreferencesPatch,
  type ThemeMode,
  type ThemeRgb,
  type ThemeTokenName,
  type ThemeVariant,
} from "@lucent/core/settings";
import type { UpdateCheckState } from "../../../shared/updates";
import { MAX_GAME_VIEWS_PER_WINDOW } from "../../../shared/gameViews";

type HotkeyBindings = readonly HotkeyBinding[];
type HotkeyListSegment =
  | {
      readonly type: "command";
      readonly command: CommandDefinition;
    }
  | {
      readonly type: "group";
      readonly label: NonNullable<CommandDefinition["group"]>;
      readonly commands: readonly CommandDefinition[];
    };

const defaultSettings: AppSettings = DEFAULT_APP_SETTINGS;
const DEFAULT_THEME_TOKENS = {
  light: DEFAULT_APP_SETTINGS.appearance.themes.light.tokens,
  dark: DEFAULT_APP_SETTINGS.appearance.themes.dark.tokens,
} as const;
const DEFAULT_THEME_PROFILE = DEFAULT_APP_SETTINGS.appearance.themes.dark;
const GAME_COMMANDS = SETTINGS_COMMANDS;

const segmentHotkeyCommands = (
  commands: readonly CommandDefinition[],
): readonly HotkeyListSegment[] => {
  const segments: HotkeyListSegment[] = [];

  for (const command of commands) {
    if (command.group === undefined) {
      segments.push({ type: "command", command });
      continue;
    }

    const previous = segments.at(-1);
    if (previous?.type === "group" && previous.label === command.group) {
      segments[segments.length - 1] = {
        ...previous,
        commands: [...previous.commands, command],
      };
      continue;
    }

    segments.push({
      type: "group",
      label: command.group,
      commands: [command],
    });
  }

  return segments;
};

export type SettingsTabId = "general" | "hotkeys" | "appearance";

export interface SettingsViewFixture {
  readonly activeTab?: SettingsTabId;
  readonly error?: string;
  readonly settings: AppSettings;
  readonly updateState?: UpdateCheckState;
}

export interface SettingsViewProps {
  readonly fixture: SettingsViewFixture;
  readonly getSettings?: () => Promise<AppSettings>;
  readonly getUpdateState?: () => Promise<UpdateCheckState>;
  readonly onAppearancePatch?: (patch: AppearancePatch) => Promise<AppSettings>;
  readonly onCheckForUpdates?: () => Promise<UpdateCheckState>;
  readonly onHotkeysPatch?: (patch: HotkeysPatch) => Promise<AppSettings>;
  readonly onOpenReleasePage?: () => Promise<boolean>;
  readonly onPreferencesPatch?: (
    patch: PreferencesPatch,
  ) => Promise<AppSettings>;
  readonly onResetHotkeys?: () => Promise<AppSettings>;
  readonly onSettingsChanged?: (
    listener: (settings: AppSettings) => void,
  ) => () => void;
  readonly onUpdatesChanged?: (
    listener: (state: UpdateCheckState) => void,
  ) => () => void;
  readonly platform: AppPlatform;
}

const settingsTabs: ReadonlyArray<{
  readonly label: string;
  readonly value: SettingsTabId;
}> = [
  { label: "General", value: "general" },
  { label: "Hotkeys", value: "hotkeys" },
  { label: "Appearance", value: "appearance" },
];

const defaultTooltipProps = {
  closeDelay: 0,
  openDelay: 200,
  positioning: { placement: "top" },
} satisfies TooltipProps;

const themeModes: ReadonlyArray<{
  readonly label: string;
  readonly value: ThemeMode;
}> = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

const themeVariants: ReadonlyArray<{
  readonly label: string;
  readonly value: ThemeVariant;
}> = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const themeVariantForMode = (mode: ThemeMode): ThemeVariant => {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const motionModes: ReadonlyArray<{
  readonly label: string;
  readonly value: MotionMode;
}> = [
  { label: "System", value: "system" },
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
];

const launchModes = [
  { label: "Game", value: "game" },
  { label: "Account Manager", value: "account-manager" },
] as const;

const commandCategories: readonly CommandCategory[] =
  SETTING_COMMAND_CATEGORIES;

const normalizeHotkeyBinding = (
  value: string,
  _platform: AppPlatform,
): string | undefined => normalizeHotkeyBindingValue(value) ?? undefined;

const clampFontSize = (value: number): number =>
  Math.min(24, Math.max(10, Math.round(value)));

const tokenLabel = (name: ThemeTokenName): string =>
  name
    .replace(/[A-Z]/g, (match) => ` ${match}`)
    .replace(/^./, (match) => match.toUpperCase());

const initialUpdateState = (settings: AppSettings): UpdateCheckState => ({
  status: settings.preferences.checkForUpdates ? "idle" : "disabled",
  currentVersion: "0.0.0",
  reason: "Update checks are disabled.",
});

const normalizeUpdateStateForPreferences = (
  state: UpdateCheckState,
  nextSettings: AppSettings,
): UpdateCheckState => {
  if (
    !nextSettings.preferences.checkForUpdates &&
    state.status !== "disabled"
  ) {
    return {
      status: "disabled",
      currentVersion: state.currentVersion,
      reason: "Update checks are disabled.",
    };
  }

  if (nextSettings.preferences.checkForUpdates && state.status === "disabled") {
    return {
      status: "idle",
      currentVersion: state.currentVersion,
    };
  }

  return state;
};

const updateStatusText = (state: UpdateCheckState): string => {
  switch (state.status) {
    case "idle":
      return "No update check has run yet.";
    case "disabled":
      return state.reason;
    case "checking":
      return "Checking for updates...";
    case "current":
      return `Lucent ${state.currentVersion} is current.`;
    case "available":
      return `Lucent ${state.latestVersion} is available. Current version: ${state.currentVersion}.`;
    case "error":
      return state.message;
  }
};

function SettingsSection(props: {
  readonly action?: JSX.Element;
  readonly children: JSX.Element;
  readonly description?: string;
  readonly id: string;
  readonly title: string;
}): JSX.Element {
  const hasHeader = () =>
    props.description !== undefined || props.action !== undefined;

  return (
    <section aria-label={props.title} class="settings-section" id={props.id}>
      <Show when={hasHeader()}>
        <header class="settings-section__header">
          <Show when={props.description}>
            {(description) => <p>{description()}</p>}
          </Show>
          <Show when={props.action}>
            {(action) => (
              <div class="settings-section__header-action">{action()}</div>
            )}
          </Show>
        </header>
      </Show>
      <div class="settings-section__content">{props.children}</div>
    </section>
  );
}

function SettingsRow(props: {
  readonly action: JSX.Element;
  readonly children?: JSX.Element;
  readonly class?: string;
  readonly description?: string;
  readonly title: string;
  readonly titleAction?: JSX.Element;
}): JSX.Element {
  return (
    <div class={props.class ? `settings-row ${props.class}` : "settings-row"}>
      <div class="settings-row__content">
        <div class="settings-row__title-line">
          <div class="settings-row__title">{props.title}</div>
          <Show when={props.titleAction}>
            {(titleAction) => (
              <div class="settings-row__title-action">{titleAction()}</div>
            )}
          </Show>
        </div>
        <Show when={props.description}>
          {(description) => (
            <div class="settings-row__description">{description()}</div>
          )}
        </Show>
      </div>
      <div class="settings-row__action">{props.action}</div>
      <Show when={props.children}>
        {(children) => <div class="settings-row__children">{children()}</div>}
      </Show>
    </div>
  );
}

function SettingsErrorNotice(props: {
  readonly id: number;
  readonly message: string;
  readonly scope?: "global" | "hotkeys";
}): JSX.Element {
  return (
    <Alert
      aria-live="polite"
      class="settings-error"
      data-error-id={props.id}
      data-scope={props.scope}
      role="alert"
      variant="error"
    >
      <AlertDescription class="settings-error__message">
        <Icon
          icon="circle_alert"
          aria-hidden="true"
          class="settings-error__icon"
        />
        <span class="settings-error__text">{props.message}</span>
      </AlertDescription>
    </Alert>
  );
}

function ResetButton(props: {
  readonly confirmLabel: string;
  readonly description: string;
  readonly iconOnly?: boolean;
  readonly label: string;
  readonly title: string;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <AlertDialog>
      {props.iconOnly ? (
        <Tooltip {...defaultTooltipProps}>
          <AlertDialogTrigger
            asChild={(dialogTriggerProps) => (
              <TooltipTrigger
                asChild={(tooltipTriggerProps) => (
                  <Button
                    {...(dialogTriggerProps(
                      tooltipTriggerProps({
                        "aria-label": props.label,
                        children: (
                          <Icon icon="rotate_ccw" class="button__icon" />
                        ),
                        class: "reset-settings-button",
                        size: "icon-sm",
                        type: "button",
                        variant: "ghost",
                      } as ButtonProps),
                    ) as ButtonProps)}
                  />
                )}
              />
            )}
          />
          <TooltipContent>{props.label}</TooltipContent>
        </Tooltip>
      ) : (
        <AlertDialogTrigger
          asChild={(triggerProps) => (
            <Button
              {...(triggerProps({
                children: props.label,
                class: "reset-settings-button",
                size: "sm",
                variant: "outline",
              } as ButtonProps) as ButtonProps)}
            />
          )}
        />
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={props.onConfirm}
            size="sm"
            variant="destructive"
          >
            {props.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HotkeyConflictPill(props: {
  readonly conflicts: readonly string[];
}): JSX.Element {
  const count = () => props.conflicts.length;
  const label = () =>
    count() === 1 ? "Shortcut conflict" : `${count()} shortcut conflicts`;

  return (
    <Tooltip
      {...defaultTooltipProps}
      interactive={false}
      openDelay={150}
      unmountOnExit
    >
      <TooltipTrigger
        asChild={(tooltipTriggerProps) => (
          <button
            {...tooltipTriggerProps({
              "aria-label": `${label()}: ${props.conflicts.join(", ")}`,
              class: "hotkey-row__conflict-pill",
              type: "button",
            } as JSX.HTMLAttributes<HTMLButtonElement>)}
          >
            <Icon icon="circle_alert" size="md" class="button__icon" />
            {count()}
          </button>
        )}
      />
      <TooltipContent class="hotkey-row__conflict-tooltip">
        <span class="hotkey-row__conflict-tooltip-title">Also used by</span>
        <span class="hotkey-row__conflict-tooltip-body">
          {props.conflicts.join(", ")}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function SegmentedControl<T extends string>(props: {
  readonly "aria-label": string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly value: T;
  }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}): JSX.Element {
  return (
    <Tabs
      aria-label={props["aria-label"]}
      class="segmented-control"
      onValueChange={(details) => props.onChange(details.value as T)}
      value={props.value}
    >
      <TabsList class="segmented-control__list">
        <For each={props.options}>
          {(option) => (
            <TabsTrigger
              class="segmented-control__trigger"
              value={option.value}
            >
              {option.label}
            </TabsTrigger>
          )}
        </For>
      </TabsList>
    </Tabs>
  );
}

function RoundingSlider(props: {
  readonly "aria-label": string;
  readonly value: number;
  readonly onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal(props.value);
  const [dragging, setDragging] = createSignal(false);

  createEffect(() => {
    const value = props.value;
    if (!untrack(dragging)) {
      setDraft(value);
    }
  });

  return (
    <Slider
      aria-label={[props["aria-label"]]}
      max={2}
      min={0}
      onValueChange={(details) => {
        setDragging(true);
        setDraft(details.value[0] ?? draft());
      }}
      onValueChangeEnd={(details) => {
        const value = details.value[0] ?? draft();
        setDraft(value);
        setDragging(false);
        props.onCommit(value);
      }}
      step={0.05}
      value={[draft()]}
    >
      <SliderValue>{draft().toFixed(2)}</SliderValue>
    </Slider>
  );
}

function FontSizeInput(props: {
  readonly "aria-label": string;
  readonly value: number;
  readonly onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal(String(props.value));
  const [focused, setFocused] = createSignal(false);

  createEffect(() => {
    const value = props.value;
    if (!untrack(focused)) {
      setDraft(String(value));
    }
  });

  const commit = () => {
    const parsed = Number(draft());
    const value = Number.isFinite(parsed) ? clampFontSize(parsed) : props.value;
    setDraft(String(value));
    props.onCommit(value);
  };

  return (
    <div class="settings-number-wrapper">
      <Input
        aria-label={props["aria-label"]}
        class="settings-number-input"
        max={24}
        min={10}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
          setDraft(event.currentTarget.value)
        }
        onKeyDown={(
          event: KeyboardEvent & { currentTarget: HTMLInputElement },
        ) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
        size="sm"
        step={1}
        type="number"
        value={draft()}
      />
      <span class="settings-number-unit">px</span>
    </div>
  );
}

function RestoreDefaultButton(props: {
  readonly "aria-label": string;
  readonly disabled: boolean;
  readonly tooltip: string;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <TooltipIconButton
      aria-label={props["aria-label"]}
      class="restore-default-button"
      disabled={props.disabled}
      onClick={props.onClick}
      tooltip={props.tooltip}
    >
      <Icon icon="rotate_ccw" class="button__icon" />
    </TooltipIconButton>
  );
}

function ThemeTokenRow(props: {
  readonly defaultValue: ThemeRgb;
  readonly name: ThemeTokenName;
  readonly value: ThemeRgb | undefined;
  readonly onChange: (value: ThemeRgb) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const isOverridden = createMemo(() => props.value !== undefined);
  const hexValue = createMemo(() =>
    rgbToHex(props.value ?? props.defaultValue),
  );
  const [draft, setDraft] = createSignal(hexValue());
  createEffect(() => {
    setDraft(hexValue());
  });

  const commit = (value: string) => {
    setDraft(value);
    const rgb = hexToRgb(value);
    if (rgb) {
      props.onChange(rgb);
    }
  };

  return (
    <div class="theme-token-row">
      <div class="theme-token-row__name">
        <span>{tokenLabel(props.name)}</span>
        <Show when={isOverridden()}>
          <RestoreDefaultButton
            aria-label={`Restore default ${tokenLabel(props.name)} color`}
            disabled={false}
            onClick={props.onReset}
            tooltip="Restore default color"
          />
        </Show>
      </div>
      <div class="theme-token-row__controls">
        <ColorPicker
          aria-label={`${tokenLabel(props.name)} color`}
          onChange={(event) => commit(event.currentTarget.value)}
          onInput={(event) => setDraft(event.currentTarget.value)}
          value={draft()}
        />
      </div>
    </div>
  );
}

function GeneralSettings(props: {
  readonly settings: AppSettings;
  readonly onPreferencesPatch: (patch: PreferencesPatch) => void;
  readonly updateState: UpdateCheckState;
  readonly checking: boolean;
  readonly onCheckForUpdates: () => void;
  readonly onOpenReleasePage: () => void;
}): JSX.Element {
  const hasReleasePage = () =>
    props.updateState.status === "available" &&
    props.updateState.release.htmlUrl.length > 0;

  return (
    <SettingsSection id="general" title="General">
      <SettingsRow
        action={
          <Switch
            aria-label="Check for updates"
            size="lg"
            checked={props.settings.preferences.checkForUpdates}
            onChange={(event) =>
              props.onPreferencesPatch({
                checkForUpdates: event.currentTarget.checked,
              })
            }
          />
        }
        class="settings-row--switch settings-row--with-subitem"
        description="Check for updates when the app starts."
        title="Check for updates"
      >
        <div class="update-status-subitem">
          <div class="update-status-subitem__content">
            <div class="update-status-subitem__label">Update status</div>
            <div class="update-status-subitem__description">
              {updateStatusText(props.updateState)}
            </div>
          </div>
          <Button
            class="update-status-subitem__button"
            disabled={props.checking}
            onClick={() =>
              hasReleasePage()
                ? props.onOpenReleasePage()
                : props.onCheckForUpdates()
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            <span>
              <Show fallback="Check for updates" when={hasReleasePage()}>
                Open release page
              </Show>
            </span>
            <Show when={hasReleasePage()}>
              <Icon
                icon="arrow_up_right"
                class="update-status-subitem__icon"
                size="sm"
              />
            </Show>
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        action={
          <SegmentedControl
            aria-label="Launch mode"
            onChange={(launchMode) => props.onPreferencesPatch({ launchMode })}
            options={launchModes}
            value={props.settings.preferences.launchMode}
          />
        }
        class="settings-row--with-subitem"
        description="Choose which window opens when the app starts."
        title="Launch mode"
      >
        <div class="settings-policy-note">
          <div class="settings-policy-note__label">AQW settings</div>
          <p class="settings-policy-note__description">
            Each account saved in Lucent keeps its own AQW settings. Game
            clients opened without a saved account use one shared set. A second
            client using the same settings gets a temporary copy. Lucent
            discards changes to that copy when the client closes.
          </p>
        </div>
      </SettingsRow>
      <SettingsRow
        action={
          <Switch
            aria-label="Use game tabs"
            checked={props.settings.preferences.useGameTabs}
            onChange={(event) =>
              props.onPreferencesPatch({
                useGameTabs: event.currentTarget.checked,
              })
            }
            size="lg"
          />
        }
        class="settings-row--switch"
        description={`Open up to ${MAX_GAME_VIEWS_PER_WINDOW} tabs in one window. Existing windows are unchanged.`}
        title="Use game tabs"
        titleAction={
          <HelpTooltip
            aria-label="About game tabs memory use"
            positioning={{ placement: "top-start" }}
            tooltip="Each additional tab starts another Flash process and increases memory use."
          />
        }
      />
      <SettingsRow
        action={
          <Switch
            aria-label="Show username in game window titles"
            checked={props.settings.preferences.showGameUsernameInWindowTitle}
            onChange={(event) =>
              props.onPreferencesPatch({
                showGameUsernameInWindowTitle: event.currentTarget.checked,
              })
            }
            size="lg"
          />
        }
        class="settings-row--switch"
        description="Add the logged-in username to each game window's title. With tabs, the title follows the selected tab."
        title="Show username in game window titles"
      />
    </SettingsSection>
  );
}

const readHotkey = (bindings: HotkeyBindings, id: GameCommandId): string => {
  return readHotkeyBinding(bindings, id);
};

const getConflictingLabels = (
  bindings: HotkeyBindings,
  id: GameCommandId,
  value: string,
): readonly string[] => {
  if (value === "") {
    return [];
  }

  return GAME_COMMANDS.filter(
    (command) =>
      command.id !== id && readHotkey(bindings, command.id) === value,
  ).map((command) => command.label);
};

function HotkeySettingsSection(props: {
  readonly platform: AppPlatform;
  readonly settings: AppSettings;
  readonly onHotkeysPatch: (patch: HotkeysPatch) => Promise<void>;
}): JSX.Element {
  const [recordingId, setRecordingId] = createSignal<GameCommandId | null>(
    null,
  );
  const [localError, setLocalError] = createSignal<{
    readonly commandId: GameCommandId;
    readonly id: number;
    readonly message: string;
  } | null>(null);
  let nextLocalErrorId = 0;

  const showLocalError = (commandId: GameCommandId, message: string): void => {
    setLocalError({ commandId, id: ++nextLocalErrorId, message });
  };

  const commitBinding = async (
    id: GameCommandId,
    value: string | null,
  ): Promise<void> => {
    const definition = GAME_COMMANDS.find((command) => command.id === id);

    if (value !== null) {
      const normalized = normalizeHotkeyBinding(value, props.platform);
      if (normalized === undefined) {
        showLocalError(id, "That shortcut is not valid.");
        return;
      }

      const conflicts = getConflictingLabels(
        props.settings.hotkeys.bindings,
        id,
        normalized,
      );
      if (conflicts.length > 0) {
        showLocalError(id, `Already assigned to ${conflicts.join(", ")}.`);
        return;
      }

      await props.onHotkeysPatch({
        bindings: [{ id, value: normalized }],
      });
      setLocalError(null);
      return;
    }

    const defaultValue = definition?.defaultHotkey ?? "";
    const conflicts = getConflictingLabels(
      props.settings.hotkeys.bindings,
      id,
      defaultValue,
    );
    if (conflicts.length > 0) {
      showLocalError(
        id,
        `Default is already assigned to ${conflicts.join(", ")}.`,
      );
      return;
    }

    await props.onHotkeysPatch({
      bindings: [{ id, value: null }],
    });
    setLocalError(null);
  };

  createEffect(() => {
    const activeId = recordingId();
    if (activeId === null) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setLocalError(null);
        setRecordingId(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        setRecordingId(null);
        void commitBinding(activeId, "");
        return;
      }

      const normalized = normalizeHotkeyBinding(
        readHotkeyInputFromEvent(event),
        props.platform,
      );
      if (normalized === undefined) {
        showLocalError(activeId, "Press a complete shortcut.");
        return;
      }

      setRecordingId(null);
      void commitBinding(activeId, normalized);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    });
  });

  const renderHotkeyRow = (command: CommandDefinition) => {
    const value = () => readHotkey(props.settings.hotkeys.bindings, command.id);
    const conflicts = () =>
      getConflictingLabels(
        props.settings.hotkeys.bindings,
        command.id,
        value(),
      );
    const isRecording = () => recordingId() === command.id;
    const displayParts = () =>
      isRecording()
        ? ["Press keys"]
        : displayHotkeyParts(value(), props.platform);

    const rowError = () => {
      const err = localError();
      return err?.commandId === command.id ? err : undefined;
    };

    return (
      <div
        class="hotkey-row"
        data-conflict={conflicts().length > 0 ? "" : undefined}
      >
        <div class="hotkey-row__content">
          <div class="hotkey-row__title-line">
            <div class="hotkey-row__title">{command.label}</div>
            <Show when={conflicts().length > 0}>
              <HotkeyConflictPill conflicts={conflicts()} />
            </Show>
          </div>
        </div>
        <div class="hotkey-row__controls">
          <div class="hotkey-row__binding">
            <Show when={command.defaultHotkey !== ""}>
              <TooltipIconButton
                aria-label={`Restore default shortcut for ${command.label}`}
                class="hotkey-row__icon-action hotkey-row__default-action"
                disabled={value() === command.defaultHotkey}
                onClick={() => void commitBinding(command.id, null)}
                tooltip="Restore default shortcut"
              >
                <Icon icon="rotate_ccw" class="button__icon" />
              </TooltipIconButton>
            </Show>
            <KbdGroup
              aria-label={
                isRecording()
                  ? "Press keys"
                  : displayHotkey(value(), props.platform)
              }
              class="hotkey-row__value"
            >
              <For each={displayParts()}>
                {(part) => (
                  <Kbd
                    class="hotkey-row__key"
                    data-empty={
                      value() === "" && !isRecording() ? "" : undefined
                    }
                  >
                    {part}
                  </Kbd>
                )}
              </For>
            </KbdGroup>
          </div>
          <Button
            class={
              isRecording()
                ? "hotkey-row__record-action hotkey-row__record-action--recording"
                : "hotkey-row__record-action"
            }
            disabled={recordingId() !== null && !isRecording()}
            onClick={() => {
              setLocalError(null);
              setRecordingId(isRecording() ? null : command.id);
            }}
            size="sm"
            type="button"
            variant={isRecording() ? "secondary" : "ghost"}
          >
            {isRecording() ? "Cancel" : "Record"}
          </Button>
          <TooltipIconButton
            aria-label={`Clear shortcut for ${command.label}`}
            class="hotkey-row__icon-action hotkey-row__clear-action"
            disabled={value() === ""}
            onClick={() => void commitBinding(command.id, "")}
            tooltip="Clear shortcut"
          >
            <Icon icon="x" class="button__icon" />
          </TooltipIconButton>
        </div>
        <Show when={rowError()}>
          {(error) => (
            <div
              class="hotkey-row__inline-error"
              data-error-id={error().id}
              role="status"
              aria-live="polite"
            >
              <Icon
                icon="circle_alert"
                aria-hidden="true"
                class="hotkey-row__inline-error-icon"
                size="xs"
              />
              {error().message}
            </div>
          )}
        </Show>
      </div>
    );
  };

  const renderHotkeysList = (commands: readonly CommandDefinition[]) => (
    <CardContent class="hotkey-list">
      <For each={segmentHotkeyCommands(commands)}>
        {(segment) => {
          if (segment.type === "command") {
            return renderHotkeyRow(segment.command);
          }

          const headingId = `hotkey-group-${segment.commands[0]?.id ?? "unknown"}`;
          return (
            <div
              class="hotkey-subgroup"
              role="group"
              aria-labelledby={headingId}
            >
              <h4 class="hotkey-subgroup__title" id={headingId}>
                {segment.label}
              </h4>
              <div class="hotkey-subgroup__rows">
                <For each={segment.commands}>{renderHotkeyRow}</For>
              </div>
            </div>
          );
        }}
      </For>
    </CardContent>
  );

  return (
    <SettingsSection id="hotkeys" title="Hotkeys">
      <div class="hotkey-layouts--continuous">
        <For each={commandCategories}>
          {(category) => (
            <div class="hotkey-category-section">
              <h3 class="hotkey-category-title">{category}</h3>
              <Card class="hotkey-group">
                {renderHotkeysList(
                  GAME_COMMANDS.filter((c) => c.category === category),
                )}
              </Card>
            </div>
          )}
        </For>
      </div>
    </SettingsSection>
  );
}

function AppearanceSettings(props: {
  readonly settings: AppSettings;
  readonly onAppearancePatch: (patch: AppearancePatch) => void;
}): JSX.Element {
  const [activeThemeVariant, setActiveThemeVariant] =
    createSignal<ThemeVariant>(
      themeVariantForMode(props.settings.appearance.themeMode),
    );
  let observedThemeMode = props.settings.appearance.themeMode;
  createEffect(() => {
    const nextThemeMode = props.settings.appearance.themeMode;
    if (nextThemeMode !== observedThemeMode) {
      observedThemeMode = nextThemeMode;
      setActiveThemeVariant(themeVariantForMode(nextThemeMode));
    }
  });
  const resetThemeProfile = (variant: ThemeVariant) => {
    props.onAppearancePatch({
      themes: {
        [variant]: {
          tokens: Object.fromEntries(
            THEME_TOKEN_NAMES.map((name) => [name, null]),
          ) as Partial<Record<ThemeTokenName, null>>,
          sansFont: DEFAULT_THEME_PROFILE.sansFont,
          monoFont: DEFAULT_THEME_PROFILE.monoFont,
          sansFontSize: DEFAULT_THEME_PROFILE.sansFontSize,
          monoFontSize: DEFAULT_THEME_PROFILE.monoFontSize,
          rounding: DEFAULT_THEME_PROFILE.rounding,
        },
      },
    });
  };
  const updateThemeProfile = (
    variant: ThemeVariant,
    patch: {
      readonly tokens?: Partial<Record<ThemeTokenName, ThemeRgb | null>>;
      readonly sansFont?: string;
      readonly monoFont?: string;
      readonly sansFontSize?: number;
      readonly monoFontSize?: number;
      readonly rounding?: number;
    },
  ) => {
    props.onAppearancePatch({
      themes: {
        [variant]: patch,
      },
    });
  };

  const renderProfileEditor = (variant: ThemeVariant) => {
    const profile = () => props.settings.appearance.themes[variant];

    return (
      <Card class="theme-profile">
        <CardHeader>
          <CardTitle>
            {variant === "light" ? "Light theme" : "Dark theme"}
          </CardTitle>
          <CardDescription>
            Fonts, rounding, and color tokens for this theme.
          </CardDescription>
          <CardAction>
            <div class="theme-profile__actions">
              <SegmentedControl
                aria-label="Theme profile"
                onChange={(value) => setActiveThemeVariant(value)}
                options={themeVariants}
                value={activeThemeVariant()}
              />
              <ResetButton
                confirmLabel="Reset"
                description={`This restores the theme's fonts, font sizes, rounding, and color token overrides.`}
                iconOnly
                label={`Reset ${variant} theme`}
                onConfirm={() => resetThemeProfile(variant)}
                title={`Reset ${variant} theme customizations?`}
              />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent class="theme-profile__rows">
          <div class="theme-profile__typography">
            <SettingsRow
              action={
                <Input
                  class="settings-text-input"
                  fullWidth
                  onChange={(event) =>
                    updateThemeProfile(variant, {
                      sansFont: event.currentTarget.value,
                    })
                  }
                  size="sm"
                  value={profile().sansFont}
                />
              }
              title="Sans font"
              titleAction={
                profile().sansFont ===
                DEFAULT_THEME_PROFILE.sansFont ? undefined : (
                  <RestoreDefaultButton
                    aria-label={`Restore default ${variant} theme sans font`}
                    disabled={false}
                    onClick={() =>
                      updateThemeProfile(variant, {
                        sansFont: DEFAULT_THEME_PROFILE.sansFont,
                      })
                    }
                    tooltip="Restore default sans font"
                  />
                )
              }
            />
            <SettingsRow
              action={
                <FontSizeInput
                  aria-label={`${variant} theme sans font size`}
                  onCommit={(sansFontSize) =>
                    updateThemeProfile(variant, {
                      sansFontSize,
                    })
                  }
                  value={profile().sansFontSize}
                />
              }
              title="Sans size"
              titleAction={
                profile().sansFontSize ===
                DEFAULT_THEME_PROFILE.sansFontSize ? undefined : (
                  <RestoreDefaultButton
                    aria-label={`Restore default ${variant} theme sans font size`}
                    disabled={false}
                    onClick={() =>
                      updateThemeProfile(variant, {
                        sansFontSize: DEFAULT_THEME_PROFILE.sansFontSize,
                      })
                    }
                    tooltip="Restore default sans size"
                  />
                )
              }
            />
            <SettingsRow
              action={
                <Input
                  class="settings-text-input"
                  fullWidth
                  onChange={(event) =>
                    updateThemeProfile(variant, {
                      monoFont: event.currentTarget.value,
                    })
                  }
                  size="sm"
                  value={profile().monoFont}
                />
              }
              title="Mono font"
              titleAction={
                profile().monoFont ===
                DEFAULT_THEME_PROFILE.monoFont ? undefined : (
                  <RestoreDefaultButton
                    aria-label={`Restore default ${variant} theme mono font`}
                    disabled={false}
                    onClick={() =>
                      updateThemeProfile(variant, {
                        monoFont: DEFAULT_THEME_PROFILE.monoFont,
                      })
                    }
                    tooltip="Restore default mono font"
                  />
                )
              }
            />
            <SettingsRow
              action={
                <FontSizeInput
                  aria-label={`${variant} theme mono font size`}
                  onCommit={(monoFontSize) =>
                    updateThemeProfile(variant, {
                      monoFontSize,
                    })
                  }
                  value={profile().monoFontSize}
                />
              }
              title="Mono size"
              titleAction={
                profile().monoFontSize ===
                DEFAULT_THEME_PROFILE.monoFontSize ? undefined : (
                  <RestoreDefaultButton
                    aria-label={`Restore default ${variant} theme mono font size`}
                    disabled={false}
                    onClick={() =>
                      updateThemeProfile(variant, {
                        monoFontSize: DEFAULT_THEME_PROFILE.monoFontSize,
                      })
                    }
                    tooltip="Restore default mono size"
                  />
                )
              }
            />
            <SettingsRow
              action={
                <div class="rounding-control">
                  <RoundingSlider
                    aria-label={`${variant} theme rounding`}
                    onCommit={(rounding) =>
                      updateThemeProfile(variant, {
                        rounding,
                      })
                    }
                    value={profile().rounding}
                  />
                </div>
              }
              class="settings-row--rounding"
              description="Adjust corner rounding across most interface elements."
              title="Rounding"
              titleAction={
                profile().rounding ===
                DEFAULT_THEME_PROFILE.rounding ? undefined : (
                  <RestoreDefaultButton
                    aria-label={`Restore default ${variant} theme rounding`}
                    disabled={false}
                    onClick={() =>
                      updateThemeProfile(variant, {
                        rounding: DEFAULT_THEME_PROFILE.rounding,
                      })
                    }
                    tooltip="Restore default rounding"
                  />
                )
              }
            />
          </div>
          <div class="theme-token-list">
            <For each={THEME_TOKEN_NAMES}>
              {(name) => (
                <ThemeTokenRow
                  defaultValue={DEFAULT_THEME_TOKENS[variant][name]}
                  name={name}
                  onChange={(value) =>
                    updateThemeProfile(variant, {
                      tokens: {
                        [name]: value,
                      },
                    })
                  }
                  onReset={() =>
                    updateThemeProfile(variant, {
                      tokens: {
                        [name]: null,
                      },
                    })
                  }
                  value={
                    rgbEquals(
                      profile().tokens[name],
                      DEFAULT_THEME_TOKENS[variant][name],
                    )
                      ? undefined
                      : profile().tokens[name]
                  }
                />
              )}
            </For>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <SettingsSection id="appearance" title="Appearance">
      <SettingsRow
        action={
          <SegmentedControl
            aria-label="Theme mode"
            onChange={(themeMode) => {
              setActiveThemeVariant(themeVariantForMode(themeMode));
              props.onAppearancePatch({ themeMode });
            }}
            options={themeModes}
            value={props.settings.appearance.themeMode}
          />
        }
        description="Choose the app color mode."
        title="Theme"
      />
      <SettingsRow
        action={
          <SegmentedControl
            aria-label="Reduce motion"
            onChange={(reduceMotion) =>
              props.onAppearancePatch({ reduceMotion })
            }
            options={motionModes}
            value={props.settings.appearance.reduceMotion}
          />
        }
        description="Limit animations and transitions."
        title="Reduce motion"
      />
      <SettingsRow
        action={
          <Switch
            aria-label="Use cursor pointers"
            checked={props.settings.appearance.useCursorPointers}
            onChange={(event) =>
              props.onAppearancePatch({
                useCursorPointers: event.currentTarget.checked,
              })
            }
            size="lg"
          />
        }
        class="settings-row--switch"
        description="Show a pointer cursor over clickable controls."
        title="Use cursor pointers"
      />
      <div class="theme-profile-panel">
        {renderProfileEditor(activeThemeVariant())}
      </div>
    </SettingsSection>
  );
}

/** Renders Settings from typed application and updater state. */
export function SettingsView(props: SettingsViewProps): JSX.Element {
  const [settings, setSettings] = createSignal<AppSettings>(
    props.fixture.settings,
  );
  const [liveUpdateState, setLiveUpdateState] = createSignal<UpdateCheckState>(
    props.fixture.updateState ?? initialUpdateState(settings()),
  );
  const [updateCheckPending, setUpdateCheckPending] = createSignal(false);
  const [error, setError] = createSignal<{
    readonly id: number;
    readonly message: string;
  } | null>(
    props.fixture.error === undefined
      ? null
      : { id: 1, message: props.fixture.error },
  );
  const [activeTab, setActiveTab] = createSignal<SettingsTabId>(
    props.fixture.activeTab ?? "general",
  );
  let nextErrorId = 0;

  const showError = (message: string): void => {
    setError({ id: ++nextErrorId, message });
  };

  const runSettingsUpdate = async (
    update: Promise<AppSettings>,
  ): Promise<void> => {
    try {
      setSettings(await update);
      setError(null);
    } catch (cause) {
      console.error("Failed to update settings:", cause);
      showError(
        cause instanceof Error ? cause.message : "Settings update failed",
      );
    }
  };

  const applyUpdateState = (
    state: UpdateCheckState,
    options?: { readonly allowWhenDisabled?: boolean },
  ): void => {
    setLiveUpdateState(
      options?.allowWhenDisabled === true
        ? state
        : normalizeUpdateStateForPreferences(state, settings()),
    );
  };

  createEffect(() => {
    const nextSettings = settings();
    setLiveUpdateState((current) => {
      return normalizeUpdateStateForPreferences(current, nextSettings);
    });
  });

  const checkForUpdates = (): void => {
    const current = liveUpdateState();
    if (updateCheckPending() || current.status === "checking") {
      return;
    }

    setUpdateCheckPending(true);
    setLiveUpdateState({
      status: "checking",
      currentVersion: current.currentVersion,
      startedAt: new Date().toISOString(),
    });

    const update = props.onCheckForUpdates?.();
    if (update === undefined) {
      setUpdateCheckPending(false);
      return;
    }

    void update
      .then((state) => applyUpdateState(state, { allowWhenDisabled: true }))
      .catch((cause: unknown) => {
        console.error("Failed to check for updates:", cause);
        showError(
          cause instanceof Error ? cause.message : "Update check failed",
        );
      })
      .finally(() => {
        setUpdateCheckPending(false);
      });
  };

  const openReleasePage = (): void => {
    void (props.onOpenReleasePage?.() ?? Promise.resolve(false)).catch(
      (cause: unknown) => {
        console.error("Failed to open release page:", cause);
        showError(
          cause instanceof Error ? cause.message : "Release page unavailable",
        );
      },
    );
  };

  onMount(() => {
    let disposed = false;
    const unsubscribeSettings = props.onSettingsChanged?.(setSettings);
    const unsubscribeUpdates = props.onUpdatesChanged?.(applyUpdateState);

    if (props.getSettings !== undefined) {
      void props
        .getSettings()
        .then((nextSettings) => {
          if (!disposed) {
            setSettings(nextSettings);
          }
        })
        .catch((cause: unknown) => {
          if (!disposed) {
            console.error("Failed to load settings:", cause);
            showError(
              cause instanceof Error ? cause.message : "Settings unavailable",
            );
          }
        });
    }

    if (props.getUpdateState !== undefined) {
      void props
        .getUpdateState()
        .then(applyUpdateState)
        .catch((cause: unknown) => {
          console.error("Failed to load update state:", cause);
        });
    }

    onCleanup(() => {
      disposed = true;
      unsubscribeSettings?.();
      unsubscribeUpdates?.();
    });
  });

  return (
    <div class="settings-app">
      <div class="settings-layout">
        <main class="settings-main">
          <Tabs
            aria-label="Settings sections"
            class="settings-tabs"
            onValueChange={(details) =>
              setActiveTab(details.value as SettingsTabId)
            }
            value={activeTab()}
          >
            <div class="settings-tabs__bar">
              <div class="settings-tabs__bar-inner">
                <TabsList class="settings-tabs__list" variant="underline">
                  <For each={settingsTabs}>
                    {(tab) => (
                      <TabsTrigger value={tab.value}>{tab.label}</TabsTrigger>
                    )}
                  </For>
                </TabsList>
                <Show when={activeTab() === "hotkeys"}>
                  <div class="settings-tabs__bar-action settings-tabs__bar-action--full">
                    <ResetButton
                      confirmLabel="Reset hotkeys"
                      description="This restores every game-window shortcut to its default binding."
                      label="Reset hotkeys"
                      onConfirm={() =>
                        void runSettingsUpdate(
                          props.onResetHotkeys?.() ??
                            Promise.resolve(settings()),
                        )
                      }
                      title="Reset all hotkeys?"
                    />
                  </div>
                  <div class="settings-tabs__bar-action settings-tabs__bar-action--compact">
                    <ResetButton
                      confirmLabel="Reset hotkeys"
                      description="This restores every game-window shortcut to its default binding."
                      iconOnly
                      label="Reset hotkeys"
                      onConfirm={() =>
                        void runSettingsUpdate(
                          props.onResetHotkeys?.() ??
                            Promise.resolve(settings()),
                        )
                      }
                      title="Reset all hotkeys?"
                    />
                  </div>
                </Show>
              </div>
            </div>
            <div class="settings-content-scroller">
              <div class="settings-content-wrapper">
                <Show when={error()}>
                  {(notice) => (
                    <SettingsErrorNotice
                      id={notice().id}
                      message={notice().message}
                      scope="global"
                    />
                  )}
                </Show>
                <TabsContent value="general">
                  <GeneralSettings
                    checking={
                      updateCheckPending() ||
                      liveUpdateState().status === "checking"
                    }
                    onCheckForUpdates={checkForUpdates}
                    onOpenReleasePage={openReleasePage}
                    onPreferencesPatch={(patch) =>
                      void runSettingsUpdate(
                        props.onPreferencesPatch?.(patch) ??
                          Promise.resolve(settings()),
                      )
                    }
                    settings={settings()}
                    updateState={liveUpdateState()}
                  />
                </TabsContent>
                <TabsContent value="hotkeys">
                  <HotkeySettingsSection
                    onHotkeysPatch={(patch) =>
                      runSettingsUpdate(
                        props.onHotkeysPatch?.(patch) ??
                          Promise.resolve(settings()),
                      )
                    }
                    platform={props.platform}
                    settings={settings()}
                  />
                </TabsContent>
                <TabsContent value="appearance">
                  <AppearanceSettings
                    onAppearancePatch={(patch) =>
                      void runSettingsUpdate(
                        props.onAppearancePatch?.(patch) ??
                          Promise.resolve(settings()),
                      )
                    }
                    settings={settings()}
                  />
                </TabsContent>
              </div>
            </div>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

/** Connects the fixture-driven Settings view to the Electron bridge. */
export function App(props: {
  readonly initialSettings: AppSettings | null;
  readonly platform: AppPlatform;
}): JSX.Element {
  const desktop = selectDesktopBridge(window.desktop, "settings");
  const settings = desktop.settings;
  const updates = desktop.updates;
  const initialSettings = props.initialSettings ?? defaultSettings;

  return (
    <SettingsView
      fixture={{ settings: initialSettings }}
      getSettings={() => settings.get()}
      getUpdateState={() => updates.getState()}
      onAppearancePatch={(patch) => settings.updateAppearance(patch)}
      onCheckForUpdates={() => updates.checkNow()}
      onHotkeysPatch={(patch) => settings.updateHotkeys(patch)}
      onOpenReleasePage={() => updates.openReleasePage()}
      onPreferencesPatch={(patch) => settings.updatePreferences(patch)}
      onResetHotkeys={() => settings.resetHotkeys()}
      onSettingsChanged={(listener) => settings.onChanged(listener)}
      onUpdatesChanged={(listener) => updates.onChanged(listener)}
      platform={props.platform}
    />
  );
}
