import {
  Alert,
  AlertAction,
  AlertDescription,
  Icon,
  HelpTooltip,
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  IconButton,
  Input,
  Label,
  Select,
  SelectItem,
  SelectTrigger,
  VirtualizedSelectContent,
  Switch as ToggleSwitch,
  TooltipIconButton,
} from "@lucent/ui";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import {
  DEFAULT_COMBAT_PROFILE_ID,
  DEFAULT_COMBAT_PROFILE_LIBRARY,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import {
  DEFAULT_FOLLOWER_ATTEMPTS,
  DEFAULT_FOLLOWER_COMBAT_ENABLED,
  DEFAULT_FOLLOWER_COPY_WALK,
  DEFAULT_FOLLOWER_RETRY_ENABLED,
  createIdleFollowerState,
  parseFollowerLocationFallbacks,
  type FollowerStartPayload,
  type FollowerConfig,
  type FollowerState,
} from "@lucent/core/follower";
import {
  readLocalStorageValue,
  writeLocalStorageValue,
} from "../../localStorage";
import { filterPlayerRoster, observePlayerRoster } from "./playerRoster";
import { reconcileFollowerCombatProfileId } from "./profileSelection";
import { selectDesktopBridge } from "../../../shared/desktopBridge";

const selectedProfileStorageKey = "lucent.follower.selectedProfileId";

export interface FollowerViewFixture {
  readonly config?: FollowerConfig | null;
  readonly error?: string;
  readonly library: CombatProfileLibrary;
  readonly players?: readonly string[];
  readonly state: FollowerState;
}

export interface FollowerViewCallbacks {
  readonly configure?: (
    configuration: FollowerStartPayload,
  ) => Promise<FollowerState>;
  readonly getConfig?: () => Promise<FollowerConfig | null>;
  readonly getLibrary?: () => Promise<CombatProfileLibrary>;
  readonly getPlayers?: () => Promise<readonly string[]>;
  readonly getState?: () => Promise<FollowerState>;
  readonly me?: () => Promise<string>;
  readonly onFollowerChanged?: (
    listener: (state: FollowerState) => void,
  ) => () => void;
  readonly onLibraryChanged?: (
    listener: (library: CombatProfileLibrary) => void,
  ) => () => void;
  readonly onPlayersChanged?: (
    listener: (players: readonly string[]) => void,
  ) => () => void;
  readonly openCombatProfiles?: () => Promise<void>;
  readonly start?: (
    configuration: FollowerStartPayload,
  ) => Promise<FollowerState>;
  readonly stop?: () => Promise<FollowerState>;
}

export interface FollowerViewProps {
  readonly callbacks?: FollowerViewCallbacks;
  readonly fixture: FollowerViewFixture;
}

function LabelHelp(props: {
  readonly label: string;
  readonly tooltip: string;
}): JSX.Element {
  return (
    <span class="follower-label-help">
      <span>{props.label}</span>
      <HelpTooltip aria-label={`${props.label} help`} tooltip={props.tooltip} />
    </span>
  );
}

/** Renders Follower state from typed fixtures and optional interactions. */
export function FollowerView(props: FollowerViewProps): JSX.Element {
  const initialConfig = props.fixture.config ?? null;
  const [state, setState] = createSignal<FollowerState>(props.fixture.state);
  const [library, setLibrary] = createSignal<CombatProfileLibrary>(
    props.fixture.library,
  );
  const [targetName, setTargetName] = createSignal(
    initialConfig?.targetName ?? "",
  );
  const [players, setPlayers] = createSignal<readonly string[]>(
    props.fixture.players ?? [],
  );
  const [combatEnabled, setCombatEnabled] = createSignal(
    initialConfig?.combatEnabled ?? DEFAULT_FOLLOWER_COMBAT_ENABLED,
  );
  const [copyWalk, setCopyWalk] = createSignal(
    initialConfig?.copyWalk ?? DEFAULT_FOLLOWER_COPY_WALK,
  );
  const [retryEnabled, setRetryEnabled] = createSignal(
    initialConfig?.retryEnabled ?? DEFAULT_FOLLOWER_RETRY_ENABLED,
  );
  const [maxAttempts, setMaxAttempts] = createSignal(
    initialConfig?.maxAttempts ?? DEFAULT_FOLLOWER_ATTEMPTS,
  );
  const [selectedProfileId, setSelectedProfileId] = createSignal(
    initialConfig?.selectedProfileId ??
      readLocalStorageValue(selectedProfileStorageKey) ??
      DEFAULT_COMBAT_PROFILE_ID,
  );
  const [attackPriority, setAttackPriority] = createSignal(
    initialConfig?.attackPriority.join(", ") ?? "",
  );
  const [lockedZoneFallbacks, setLockedZoneFallbacks] = createSignal<
    readonly string[]
  >(initialConfig?.lockedZoneFallbacks ?? []);
  const [lockedZoneFallbackInput, setLockedZoneFallbackInput] =
    createSignal("");
  const [lockedZoneRoomOverride, setLockedZoneRoomOverride] = createSignal(
    initialConfig?.lockedZoneRoomOverride ?? "",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(props.fixture.error ?? "");
  const [dismissedIssue, setDismissedIssue] = createSignal(false);
  let previousIssueKey = "";
  let configurationEffectReady = false;
  let configurationRevision = 0;
  let disposed = false;

  const running = createMemo(() => state().enabled || state().running);
  const profileOptions = createMemo(() => {
    const profiles = library().profiles;
    const generic = profiles.find(
      (profile) => profile.id === DEFAULT_COMBAT_PROFILE_ID,
    );
    const rest = profiles.filter(
      (profile) => profile.id !== DEFAULT_COMBAT_PROFILE_ID,
    );
    return generic ? [generic, ...rest] : rest;
  });
  const profileSelectItems = createMemo(() =>
    profileOptions().map((profile) => ({
      label: profile.label,
      searchText: profile.classNames?.join(" "),
      value: profile.id,
    })),
  );
  const filteredPlayers = createMemo(() =>
    filterPlayerRoster(players(), targetName()),
  );
  const playerItems = createMemo(() =>
    filteredPlayers().map((player) => ({ label: player, value: player })),
  );
  const selectedPlayerValue = createMemo(() => {
    const target = targetName().trim();
    const selected = players().find(
      (player) =>
        player.localeCompare(target, undefined, { sensitivity: "accent" }) ===
        0,
    );
    return selected === undefined ? [] : [selected];
  });
  const selectedProfileLabel = createMemo(
    () =>
      profileOptions().find((profile) => profile.id === selectedProfileId())
        ?.label ??
      selectedProfileId() ??
      "",
  );
  const exhaustedFollowerAttempts = createMemo(() => {
    const current = state();
    return (
      !current.enabled &&
      !current.running &&
      current.attemptsRemaining <= 0 &&
      current.stoppedReason !== "Stopped by user"
    );
  });
  const errorIssueMessage = createMemo(() => {
    const current = state();
    const followerMessages = exhaustedFollowerAttempts()
      ? [current.stoppedReason ?? "", current.lastError ?? ""]
      : [];
    const messages = [error(), ...followerMessages].filter(Boolean);
    return [...new Set(messages)].join(" - ");
  });
  const issueMessage = createMemo(
    () => errorIssueMessage() || state().warning || "",
  );
  const issueVariant = createMemo(() =>
    errorIssueMessage() === "" ? "warning" : "error",
  );
  const showIssue = createMemo(
    () => issueMessage() !== "" && !dismissedIssue(),
  );

  const readConfiguration = (): FollowerStartPayload => ({
    targetName: targetName(),
    combatEnabled: combatEnabled(),
    copyWalk: copyWalk(),
    retryEnabled: retryEnabled(),
    maxAttempts: maxAttempts(),
    selectedProfileId: selectedProfileId(),
    attackPriority: attackPriority(),
    lockedZoneFallbacks: lockedZoneFallbacks(),
    lockedZoneRoomOverride: lockedZoneRoomOverride(),
  });

  createEffect(() => {
    const configuration = readConfiguration();
    if (!configurationEffectReady) {
      configurationEffectReady = true;
      return;
    }

    const revision = ++configurationRevision;
    const update = props.callbacks?.configure?.(configuration);
    if (update === undefined) {
      return;
    }

    void update.catch((cause: unknown) => {
      console.error("Failed to sync follower configuration:", cause);
      if (!disposed && revision === configurationRevision) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Failed to sync follower configuration",
        );
      }
    });
  });

  onCleanup(() => {
    disposed = true;
  });

  createEffect(() => {
    const key = issueMessage();
    if (key !== previousIssueKey) {
      previousIssueKey = key;
      setDismissedIssue(false);
    }
  });

  const selectProfile = (profileId: string): void => {
    setSelectedProfileId(profileId);
    writeLocalStorageValue(selectedProfileStorageKey, profileId);
  };

  const applyLibrary = (nextLibrary: CombatProfileLibrary): void => {
    setLibrary(nextLibrary);
    const nextProfileId = reconcileFollowerCombatProfileId(
      nextLibrary,
      selectedProfileId(),
    );
    if (nextProfileId !== selectedProfileId()) {
      selectProfile(nextProfileId);
    }
  };

  const applyFollowerState = (nextState: FollowerState): void => {
    setState(nextState);
    if (targetName().trim() === "" && nextState.targetName.trim() !== "") {
      setTargetName(nextState.targetName);
    }
    if (
      nextState.enabled ||
      nextState.running ||
      (nextState.phase === "idle" && nextState.lastError === undefined)
    ) {
      if (nextState.warning === undefined) {
        setDismissedIssue(false);
      }
      setError("");
    }
  };

  const applyFollowerConfig = (config: FollowerConfig | null): void => {
    if (config === null) {
      return;
    }

    batch(() => {
      setTargetName(config.targetName || state().targetName);
      setCombatEnabled(config.combatEnabled);
      setCopyWalk(config.copyWalk);
      setRetryEnabled(config.retryEnabled);
      setMaxAttempts(config.maxAttempts);
      setSelectedProfileId(config.selectedProfileId);
      setAttackPriority(config.attackPriority.join(", "));
      setLockedZoneFallbacks(config.lockedZoneFallbacks);
      setLockedZoneRoomOverride(config.lockedZoneRoomOverride);
    });
  };

  const fillMe = async (): Promise<void> => {
    setError("");
    try {
      const me = await (props.callbacks?.me?.() ?? Promise.resolve(""));
      if (me.trim()) {
        setTargetName(me);
      }
    } catch (cause) {
      console.error("Failed to resolve current player:", cause);
      setError(cause instanceof Error ? cause.message : "Failed to get player");
    }
  };

  const openCombatProfiles = async (): Promise<void> => {
    setError("");
    try {
      await props.callbacks?.openCombatProfiles?.();
    } catch (cause) {
      console.error("Failed to open combat profiles:", cause);
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to open combat profiles",
      );
    }
  };

  const start = async (): Promise<void> => {
    const trimmedTarget = targetName().trim();
    if (!trimmedTarget || busy()) {
      return;
    }

    setBusy(true);
    setError("");
    setDismissedIssue(false);
    try {
      const nextState = await (props.callbacks?.start?.({
        ...readConfiguration(),
        targetName: trimmedTarget,
      }) ?? Promise.resolve(state()));
      applyFollowerState(nextState);
    } catch (cause) {
      console.error("Failed to start follower:", cause);
      setError(
        cause instanceof Error ? cause.message : "Failed to start follower",
      );
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (busy()) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const nextState = await (props.callbacks?.stop?.() ??
        Promise.resolve(state()));
      applyFollowerState(nextState);
    } catch (cause) {
      console.error("Failed to stop follower:", cause);
      setError(
        cause instanceof Error ? cause.message : "Failed to stop follower",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (): void => {
    if (running()) {
      void stop();
    } else {
      void start();
    }
  };

  const PlayerPicker = (): JSX.Element => (
    <div class="follower-target-row">
      <Combobox
        class="follower-player-combobox"
        allowCustomValue
        disabled={running()}
        inputBehavior="autohighlight"
        inputValue={targetName()}
        items={playerItems()}
        openOnClick
        value={selectedPlayerValue()}
        onInputValueChange={(details) => {
          if (
            details.reason === "input-change" ||
            details.reason === "item-select" ||
            details.reason === "clear-trigger"
          ) {
            setTargetName(details.inputValue);
          }
        }}
        onValueChange={(details) => {
          const selected = details.value[0];
          if (selected !== undefined) {
            setTargetName(selected);
          }
        }}
      >
        <ComboboxInput
          id="follower-target-name"
          aria-label="Player name"
          autocomplete="off"
          disabled={running()}
          placeholder="Player name"
        />
        <ComboboxContent>
          <ComboboxEmpty>
            {players().length === 0
              ? "No players in map"
              : "No matching players"}
          </ComboboxEmpty>
          <ComboboxList>
            <For each={filteredPlayers()}>
              {(player) => <ComboboxItem value={player}>{player}</ComboboxItem>}
            </For>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <Button
        size="sm"
        variant="outline"
        disabled={running()}
        onClick={() => void fillMe()}
      >
        <Icon icon="user_round" class="button__icon" />
        Me
      </Button>
    </div>
  );

  const CombatFields = (): JSX.Element => (
    <>
      <div class="follower-profile-field">
        <Button
          aria-label="Open combat profiles"
          class="follower-profile-access"
          size="xs"
          variant="ghost"
          onClick={() => void openCombatProfiles()}
        >
          <span>Combat Profile</span>
          <Icon icon="arrow_up_right" class="button__icon" />
        </Button>
        <Select
          items={profileSelectItems()}
          value={[selectedProfileId()]}
          disabled={running() || !combatEnabled()}
          onValueChange={(details) => {
            const id = details.value[0];
            if (id) {
              selectProfile(id);
            }
          }}
        >
          <SelectTrigger aria-label="Selected combat profile">
            <span
              class="select__value"
              data-placeholder={selectedProfileLabel() === "" ? "" : undefined}
            >
              {selectedProfileLabel() || "Combat profile"}
            </span>
          </SelectTrigger>
          <VirtualizedSelectContent items={profileSelectItems()} searchable>
            {(profile) => (
              <SelectItem item={profile} value={profile.value}>
                {profile.label}
              </SelectItem>
            )}
          </VirtualizedSelectContent>
        </Select>
      </div>
      <Field
        class="follower-field follower-field--priority"
        label="Attack priority"
        for="follower-attack-priority"
      >
        <Input
          id="follower-attack-priority"
          value={attackPriority()}
          placeholder="Defense Drone, Attack Drone"
          autocomplete="off"
          disabled={running() || !combatEnabled()}
          onInput={(event) => setAttackPriority(event.currentTarget.value)}
        />
      </Field>
    </>
  );

  const AttemptsControl = (): JSX.Element => (
    <Label class="follower-inline-number" for="follower-retry-attempts">
      <span>Attempts</span>
      <Input
        id="follower-retry-attempts"
        class="follower-retry-attempts-input"
        type="number"
        min="1"
        step="1"
        value={String(maxAttempts())}
        disabled={running() || !retryEnabled()}
        onInput={(event) => {
          const parsed = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isFinite(parsed)) {
            setMaxAttempts(Math.max(1, parsed));
          }
        }}
      />
    </Label>
  );

  const addLockedZoneFallbacks = (event: SubmitEvent): void => {
    event.preventDefault();
    const additions = parseFollowerLocationFallbacks(
      lockedZoneFallbackInput().replaceAll(";", "\n"),
    );
    setLockedZoneFallbackInput("");
    if (additions.length === 0) {
      return;
    }

    setLockedZoneFallbacks((current) => {
      const identities = new Set(
        current.map((location) => location.toLowerCase()),
      );
      return [
        ...current,
        ...additions.filter((location) => {
          const identity = location.toLowerCase();
          if (identities.has(identity)) {
            return false;
          }
          identities.add(identity);
          return true;
        }),
      ];
    });
  };

  const removeLockedZoneFallback = (location: string): void => {
    const identity = location.toLowerCase();
    setLockedZoneFallbacks((current) =>
      current.filter((candidate) => candidate.toLowerCase() !== identity),
    );
  };

  const LockedZoneFields = (): JSX.Element => (
    <>
      <div class="follower-field follower-field--fallbacks">
        <Label for="follower-locked-zone-fallback">Locked-zone locations</Label>
        <form class="follower-location-entry" onSubmit={addLockedZoneFallbacks}>
          <Input
            id="follower-locked-zone-fallback"
            value={lockedZoneFallbackInput()}
            placeholder="ultradage-12345"
            autocomplete="off"
            spellcheck={false}
            disabled={running() || !retryEnabled()}
            onInput={(event) =>
              setLockedZoneFallbackInput(event.currentTarget.value)
            }
          />
          <TooltipIconButton
            type="submit"
            size="icon"
            aria-label="Add locked-zone location"
            tooltip="Add location"
            disabled={
              running() ||
              !retryEnabled() ||
              lockedZoneFallbackInput().trim() === ""
            }
          >
            <Icon icon="plus" class="button__icon" />
          </TooltipIconButton>
        </form>
        <div class="follower-location-list" aria-label="Locked-zone locations">
          <Show
            when={lockedZoneFallbacks().length > 0}
            fallback={
              <span class="follower-location-list__empty">No locations</span>
            }
          >
            <For each={lockedZoneFallbacks()}>
              {(location) => {
                return (
                  <div class="follower-location-chip">
                    <span class="follower-location-chip__label">
                      {location}
                    </span>
                    <IconButton
                      type="button"
                      class="follower-location-chip__remove"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${location}`}
                      disabled={running() || !retryEnabled()}
                      onClick={() => removeLockedZoneFallback(location)}
                    >
                      <Icon icon="x" class="button__icon" />
                    </IconButton>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>
      <Field
        class="follower-field follower-field--room"
        label={
          <LabelHelp
            label="Room override"
            tooltip="Used only for locked-zone maps without a room suffix."
          />
        }
        for="follower-locked-zone-room"
      >
        <Input
          id="follower-locked-zone-room"
          class="follower-room-input"
          value={lockedZoneRoomOverride()}
          placeholder="12345"
          inputMode="numeric"
          autocomplete="off"
          disabled={running() || !retryEnabled()}
          onInput={(event) =>
            setLockedZoneRoomOverride(event.currentTarget.value)
          }
        />
      </Field>
    </>
  );

  onMount(() => {
    const unsubscribeFollower =
      props.callbacks?.onFollowerChanged?.(applyFollowerState);
    const unsubscribePlayers =
      props.callbacks?.getPlayers !== undefined &&
      props.callbacks.onPlayersChanged !== undefined
        ? observePlayerRoster(
            {
              getPlayers: props.callbacks.getPlayers,
              onPlayersChanged: props.callbacks.onPlayersChanged,
            },
            setPlayers,
            (cause) => {
              console.error("Failed to load players in map:", cause);
            },
          )
        : undefined;
    const unsubscribeProfiles =
      props.callbacks?.onLibraryChanged?.(applyLibrary);

    if (props.callbacks?.getConfig !== undefined) {
      void props.callbacks
        .getConfig()
        .then(applyFollowerConfig)
        .catch((cause: unknown) => {
          console.error("Failed to load follower configuration:", cause);
          setError("Failed to load follower configuration");
        });
    }

    if (props.callbacks?.getState !== undefined) {
      void props.callbacks
        .getState()
        .then(applyFollowerState)
        .catch((cause: unknown) => {
          console.error("Failed to load follower state:", cause);
          setError("Failed to load follower state");
        });
    }

    if (props.callbacks?.getLibrary !== undefined) {
      void props.callbacks
        .getLibrary()
        .then(applyLibrary)
        .catch((cause: unknown) => {
          console.error("Failed to load combat profiles:", cause);
          setError("Failed to load combat profiles");
        });
    }

    onCleanup(() => {
      unsubscribeFollower?.();
      unsubscribePlayers?.();
      unsubscribeProfiles?.();
    });
  });

  return (
    <div class="standalone-window follower-window">
      <div class="standalone-window__content-frame">
        <main
          class="standalone-window__content follower-body"
          aria-label="Follower controls"
        >
          <section class="follower-shell">
            <Show when={showIssue()}>
              <Alert class="follower-issue" variant={issueVariant()}>
                <AlertDescription class="follower-issue__message">
                  <Icon icon="circle_alert" aria-hidden="true" />
                  <span>{issueMessage()}</span>
                </AlertDescription>
                <AlertAction>
                  <IconButton
                    aria-label="Dismiss follower status"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setDismissedIssue(true)}
                  >
                    <Icon icon="x" class="button__icon" />
                  </IconButton>
                </AlertAction>
              </Alert>
            </Show>

            <section
              class="follower-layout follower-layout--focus"
              data-layout="focus"
              aria-label="Focused follower controls"
            >
              <div class="follower-focus__command">
                <div class="follower-focus__command-label">Target</div>
                <PlayerPicker />
                <Button
                  class="follower-focus__start"
                  disabled={busy() || (!running() && !targetName().trim())}
                  size="sm"
                  variant={running() ? "destructive" : "default"}
                  onClick={toggle}
                >
                  {running() ? "Stop" : "Start"}
                </Button>
              </div>

              <div class="follower-focus__behaviors">
                <div class="follower-focus__section-label">Behavior</div>

                <section class="follower-focus__behavior">
                  <div class="follower-focus__behavior-row">
                    <div class="follower-focus__behavior-title">
                      Copy movement
                    </div>
                    <ToggleSwitch
                      aria-label="Copy movement"
                      checked={copyWalk()}
                      disabled={running()}
                      size="sm"
                      onChange={(event) =>
                        setCopyWalk(event.currentTarget.checked)
                      }
                    />
                  </div>
                </section>

                <section class="follower-focus__behavior">
                  <div class="follower-focus__behavior-row">
                    <div class="follower-focus__behavior-title">Combat</div>
                    <ToggleSwitch
                      aria-label="Combat"
                      checked={combatEnabled()}
                      disabled={running()}
                      size="sm"
                      onChange={(event) =>
                        setCombatEnabled(event.currentTarget.checked)
                      }
                    />
                  </div>
                  <Show when={combatEnabled()}>
                    <div class="follower-focus__behavior-body follower-focus__behavior-body--combat">
                      <CombatFields />
                    </div>
                  </Show>
                </section>

                <section class="follower-focus__behavior">
                  <div class="follower-focus__behavior-row">
                    <div class="follower-focus__behavior-title">Recovery</div>
                    <div class="follower-focus__behavior-summary follower-focus__behavior-summary--attempts">
                      <Show when={retryEnabled()} fallback="Off">
                        <AttemptsControl />
                      </Show>
                    </div>
                    <ToggleSwitch
                      aria-label="Recovery"
                      checked={retryEnabled()}
                      disabled={running()}
                      size="sm"
                      onChange={(event) =>
                        setRetryEnabled(event.currentTarget.checked)
                      }
                    />
                  </div>
                  <Show when={retryEnabled()}>
                    <div class="follower-focus__behavior-body follower-focus__behavior-body--recovery">
                      <div class="follower-locked-zone-grid">
                        <LockedZoneFields />
                      </div>
                    </div>
                  </Show>
                </section>
              </div>
            </section>
          </section>
        </main>
      </div>
    </div>
  );
}

/** Connects the fixture-driven Follower view to the Electron bridge. */
export function App(): JSX.Element {
  const desktop = selectDesktopBridge(window.desktop, "follower");
  const follower = desktop.follower;
  const combatProfiles = desktop.combatProfiles;

  return (
    <FollowerView
      callbacks={{
        configure: (configuration) => follower.configure(configuration),
        getConfig: () => follower.getConfig(),
        getLibrary: () => combatProfiles.getState(),
        getPlayers: () => follower.getPlayers(),
        getState: () => follower.getState(),
        me: () => follower.me(),
        onFollowerChanged: (listener) => follower.onChanged(listener),
        onLibraryChanged: (listener) => combatProfiles.onChanged(listener),
        onPlayersChanged: (listener) => follower.onPlayersChanged(listener),
        openCombatProfiles: async () => {
          await desktop.windows.open("combat-profiles");
        },
        start: (configuration) => follower.start(configuration),
        stop: () => follower.stop(),
      }}
      fixture={{
        library: DEFAULT_COMBAT_PROFILE_LIBRARY,
        state: createIdleFollowerState(),
      }}
    />
  );
}
