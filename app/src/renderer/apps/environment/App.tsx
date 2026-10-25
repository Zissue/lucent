import {
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDescription,
  Button,
  Checkbox,
  Empty,
  Icon,
  HelpTooltip,
  IconButton,
  Input,
  PillButton,
  TooltipButton,
  TooltipButtonContent,
  TooltipButtonTrigger,
  TooltipIconButton,
} from "@lucent/ui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { SectionPanel } from "../../components/SectionPanel";
import {
  environmentBoostWithdrawalSummary,
  prepareEnvironmentBankBoosts,
  type EnvironmentBankBoostOption,
} from "./boosts";
import {
  parseEnvironmentQuestBulkInput,
  splitEnvironmentBulkInput,
} from "./input";
import {
  EnvironmentItemBuckets,
  createEmptyEnvironmentState,
  type EnvironmentAutomationCapability,
  type EnvironmentItemBucket,
  type EnvironmentItemRules,
  type EnvironmentQuestAutoRegisterOptions,
  type EnvironmentQuestRegistration,
  type EnvironmentState,
} from "@lucent/core/environment";
import { selectDesktopBridge } from "../../../shared/desktopBridge";
import type { EnvironmentBoostDiscovery } from "../../../shared/environmentBoosts";

export interface EnvironmentViewFixture {
  readonly error?: string;
  readonly state: EnvironmentState;
}

export interface EnvironmentViewCallbacks {
  readonly addBoosts?: (names: readonly string[]) => Promise<EnvironmentState>;
  readonly addItems?: (names: readonly string[]) => Promise<EnvironmentState>;
  readonly addQuests?: (
    quests: readonly EnvironmentQuestRegistration[],
  ) => Promise<EnvironmentState>;
  readonly clear?: () => Promise<EnvironmentState>;
  readonly clearBoosts?: () => Promise<EnvironmentState>;
  readonly clearItems?: () => Promise<EnvironmentState>;
  readonly clearQuestReward?: (questId: number) => Promise<EnvironmentState>;
  readonly clearQuests?: () => Promise<EnvironmentState>;
  readonly fetchBoosts?: () => Promise<EnvironmentBoostDiscovery>;
  readonly getState?: () => Promise<EnvironmentState>;
  readonly onStateChanged?: (
    listener: (state: EnvironmentState) => void,
  ) => () => void;
  readonly removeBoost?: (name: string) => Promise<EnvironmentState>;
  readonly removeItem?: (name: string) => Promise<EnvironmentState>;
  readonly removeQuest?: (questId: number) => Promise<EnvironmentState>;
  readonly setAutomationEnabled?: (
    capability: EnvironmentAutomationCapability,
    enabled: boolean,
  ) => Promise<EnvironmentState>;
  readonly setItemNotification?: (
    name: string,
    enabled: boolean,
  ) => Promise<EnvironmentState>;
  readonly setItemRules?: (
    rules: EnvironmentItemRules,
  ) => Promise<EnvironmentState>;
  readonly setQuestAutoRegister?: (
    options: EnvironmentQuestAutoRegisterOptions,
  ) => Promise<EnvironmentState>;
  readonly setQuestReward?: (
    questId: number,
    rewardItemId: number,
  ) => Promise<EnvironmentState>;
  readonly syncToAll?: () => Promise<EnvironmentState>;
  readonly withdrawBoosts?: (
    itemIds: readonly number[],
  ) => Promise<readonly number[]>;
}

export interface EnvironmentViewProps {
  readonly callbacks?: EnvironmentViewCallbacks;
  readonly fixture: EnvironmentViewFixture;
}

const bucketLabels: Record<EnvironmentItemBucket, string> = {
  "ac-member": "AC member-only",
  "ac-non-member": "AC non-member",
  "non-ac-member": "Non-AC member-only",
  "non-ac-non-member": "Non-AC non-member",
};

function EmptyList(props: { readonly label: string }): JSX.Element {
  return <Empty class="environment-empty">{props.label}</Empty>;
}

function AutomationAction(props: {
  readonly enabled: boolean;
  readonly label: string;
  readonly onChange: (enabled: boolean) => void;
}): JSX.Element {
  const action = () => (props.enabled ? "Stop" : "Start");

  return (
    <Button
      aria-label={`${action()} ${props.label}`}
      class="environment-automation-action"
      size="sm"
      variant={props.enabled ? "destructive-outline" : "outline"}
      onClick={() => props.onChange(!props.enabled)}
    >
      {action()}
    </Button>
  );
}

/** Renders Environment state with optional callbacks for stateful interactions. */
export function EnvironmentView(props: EnvironmentViewProps): JSX.Element {
  const [state, setState] = createSignal<EnvironmentState>(props.fixture.state);
  const [questInput, setQuestInput] = createSignal("");
  const [itemInput, setItemInput] = createSignal("");
  const [boostInput, setBoostInput] = createSignal("");
  const [clearingAll, setClearingAll] = createSignal(false);
  const [clearDialogOpen, setClearDialogOpen] = createSignal(false);
  const [fetchingBoosts, setFetchingBoosts] = createSignal(false);
  const [withdrawingBoosts, setWithdrawingBoosts] = createSignal(false);
  const [bankBoostDialogOpen, setBankBoostDialogOpen] = createSignal(false);
  const [bankBoosts, setBankBoosts] = createSignal<
    readonly EnvironmentBankBoostOption[]
  >([]);
  const [selectedBankBoostIds, setSelectedBankBoostIds] = createSignal<
    ReadonlySet<number>
  >(new Set<number>());
  const [syncing, setSyncing] = createSignal(false);
  const [applyDialogOpen, setApplyDialogOpen] = createSignal(false);
  const [error, setError] = createSignal(props.fixture.error ?? "");
  const [editingQuestRewardId, setEditingQuestRewardId] = createSignal<
    number | null
  >(null);
  const questRewardInputs = new Map<number, HTMLInputElement>();
  let canceledQuestRewardEdit = false;

  const totalCount = createMemo(
    () =>
      state().questIds.length +
      state().itemNames.length +
      state().boosts.length,
  );

  createEffect(() => {
    const questId = editingQuestRewardId();
    if (questId === null) {
      return;
    }

    window.requestAnimationFrame(() => {
      const input = questRewardInputs.get(questId);
      input?.focus();
      input?.select();
    });
  });

  const runStateUpdate = async (
    update: Promise<EnvironmentState>,
  ): Promise<EnvironmentState | null> => {
    setError("");
    try {
      const nextState = await update;
      setState(nextState);
      return nextState;
    } catch (cause) {
      console.error("Environment update failed:", cause);
      setError(
        cause instanceof Error ? cause.message : "Environment update failed",
      );
      return null;
    }
  };

  const clearAll = async (): Promise<void> => {
    setClearingAll(true);
    try {
      await runStateUpdate(
        props.callbacks?.clear?.() ?? Promise.resolve(state()),
      );
    } finally {
      setClearingAll(false);
    }
  };

  const addQuests = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const tokens = parseEnvironmentQuestBulkInput(questInput());
    if (tokens.length === 0) {
      setQuestInput("");
      return;
    }

    setQuestInput("");
    await runStateUpdate(
      props.callbacks?.addQuests?.(tokens) ?? Promise.resolve(state()),
    );
  };

  const updateQuestReward = async (
    questId: number,
    value: string,
  ): Promise<void> => {
    const input = value.trim();
    if (input === "") {
      await runStateUpdate(
        props.callbacks?.clearQuestReward?.(questId) ??
          Promise.resolve(state()),
      );
      return;
    }

    const rewardItemId = Number(input);
    if (!Number.isSafeInteger(rewardItemId) || rewardItemId <= 0) {
      setError("Reward item ID must be a positive integer.");
      return;
    }

    await runStateUpdate(
      props.callbacks?.setQuestReward?.(questId, rewardItemId) ??
        Promise.resolve(state()),
    );
  };

  const updateQuestAutoRegister = async (
    options: EnvironmentQuestAutoRegisterOptions,
  ): Promise<void> => {
    await runStateUpdate(
      props.callbacks?.setQuestAutoRegister?.(options) ??
        Promise.resolve(state()),
    );
  };

  const setQuestAutoRegisterOption = async (
    option: keyof EnvironmentQuestAutoRegisterOptions,
    enabled: boolean,
  ): Promise<void> => {
    await updateQuestAutoRegister({
      ...state().questAutoRegister,
      [option]: enabled,
    });
  };

  const updateAutomation = async (
    capability: EnvironmentAutomationCapability,
    enabled: boolean,
  ): Promise<void> => {
    await runStateUpdate(
      props.callbacks?.setAutomationEnabled?.(capability, enabled) ??
        Promise.resolve(state()),
    );
  };

  const showQuestRewardInput = (questId: number): boolean =>
    state().questRewards[questId] !== undefined ||
    editingQuestRewardId() === questId;

  const editQuestReward = (questId: number): void => {
    setEditingQuestRewardId(questId);
  };

  const commitQuestReward = async (
    questId: number,
    value: string,
  ): Promise<void> => {
    setEditingQuestRewardId(null);
    await updateQuestReward(questId, value);
  };

  const cancelQuestRewardEdit: JSX.EventHandler<
    HTMLInputElement,
    KeyboardEvent
  > = (event) => {
    if (event.key === "Escape") {
      canceledQuestRewardEdit = true;
      setEditingQuestRewardId(null);
      event.currentTarget.blur();
      return;
    }

    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  const updateItemRules = async (
    itemRules: EnvironmentItemRules,
  ): Promise<void> => {
    await runStateUpdate(
      props.callbacks?.setItemRules?.(itemRules) ?? Promise.resolve(state()),
    );
  };

  const toggleItemBucket = async (
    bucket: EnvironmentItemBucket,
    checked: boolean,
  ): Promise<void> => {
    const buckets = new Set(state().itemRules.buckets);
    if (checked) {
      buckets.add(bucket);
    } else {
      buckets.delete(bucket);
    }

    await updateItemRules({
      ...state().itemRules,
      buckets: EnvironmentItemBuckets.filter((value) => buckets.has(value)),
    });
  };

  const setRejectElse = async (rejectElse: boolean): Promise<void> => {
    await updateItemRules({
      ...state().itemRules,
      rejectElse,
    });
  };

  const addItems = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const items = splitEnvironmentBulkInput(itemInput());
    setItemInput("");
    if (items.length > 0) {
      await runStateUpdate(
        props.callbacks?.addItems?.(items) ?? Promise.resolve(state()),
      );
    }
  };

  const addBoosts = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const boosts = splitEnvironmentBulkInput(boostInput());
    setBoostInput("");
    if (boosts.length > 0) {
      await runStateUpdate(
        props.callbacks?.addBoosts?.(boosts) ?? Promise.resolve(state()),
      );
    }
  };

  const resetBankBoostDialog = (): void => {
    setBankBoostDialogOpen(false);
    setBankBoosts([]);
    setSelectedBankBoostIds(new Set<number>());
  };

  const toggleBankBoost = (itemId: number, selected: boolean): void => {
    setSelectedBankBoostIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  };

  const fetchBoosts = async (): Promise<void> => {
    setFetchingBoosts(true);
    setError("");
    resetBankBoostDialog();
    try {
      const discovery = await (props.callbacks?.fetchBoosts?.() ??
        Promise.resolve({ bank: [], bankLoaded: true, inventory: [] }));
      let nextState = state();
      if (discovery.inventory.length > 0) {
        nextState =
          (await runStateUpdate(
            props.callbacks?.addBoosts?.(discovery.inventory) ??
              Promise.resolve(state()),
          )) ?? nextState;
      }

      const candidates = prepareEnvironmentBankBoosts(
        discovery.bank,
        nextState.boosts,
      );
      if (candidates.length > 0) {
        setBankBoosts(candidates);
        setBankBoostDialogOpen(true);
      }
      if (!discovery.bankLoaded) {
        setError(
          (current) =>
            current ||
            "Inventory boosts were fetched, but the bank could not be searched.",
        );
      }
    } catch (cause) {
      console.error("Failed to fetch boosts:", cause);
      setError(
        cause instanceof Error ? cause.message : "Failed to fetch boosts",
      );
    } finally {
      setFetchingBoosts(false);
    }
  };

  const withdrawSelectedBankBoosts = async (): Promise<void> => {
    const selectedIds = selectedBankBoostIds();
    const selected = bankBoosts().filter((boost) =>
      selectedIds.has(boost.itemId),
    );
    if (selected.length === 0) {
      return;
    }

    resetBankBoostDialog();
    setWithdrawingBoosts(true);
    setError("");
    try {
      const withdrawnItemIds = await (props.callbacks?.withdrawBoosts?.(
        selected.map((boost) => boost.itemId),
      ) ?? Promise.resolve([]));
      const selectedItemIds = new Set(selected.map((boost) => boost.itemId));
      const withdrawn = new Set(
        withdrawnItemIds.filter((itemId) => selectedItemIds.has(itemId)),
      );
      const names = selected
        .filter((boost) => withdrawn.has(boost.itemId))
        .map((boost) => boost.name);
      if (names.length > 0) {
        await runStateUpdate(
          props.callbacks?.addBoosts?.(names) ?? Promise.resolve(state()),
        );
      }

      const summary = environmentBoostWithdrawalSummary(
        selected.length,
        withdrawn.size,
      );
      if (summary !== "") {
        setError((current) => (current ? `${current} ${summary}` : summary));
      }
    } catch (cause) {
      console.error("Failed to withdraw boosts:", cause);
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to withdraw selected boosts",
      );
    } finally {
      setWithdrawingBoosts(false);
    }
  };

  const syncToAll = async (): Promise<void> => {
    setSyncing(true);
    try {
      await runStateUpdate(
        props.callbacks?.syncToAll?.() ?? Promise.resolve(state()),
      );
    } finally {
      setSyncing(false);
    }
  };

  onMount(() => {
    const unsubscribe = props.callbacks?.onStateChanged?.(setState);
    if (unsubscribe !== undefined) {
      onCleanup(unsubscribe);
    }

    if (props.callbacks?.getState !== undefined) {
      void props.callbacks
        .getState()
        .then(setState)
        .catch((cause: unknown) => {
          console.error("Failed to load environment state:", cause);
          setError("Failed to load environment state");
        });
    }
  });

  return (
    <div class="standalone-window environment-root">
      <header class="standalone-window__header">
        <div class="standalone-window__header-actions">
          <TooltipButton>
            <TooltipButtonTrigger
              variant="outline"
              size="sm"
              disabled={clearingAll() || totalCount() === 0}
              onClick={() => setClearDialogOpen(true)}
            >
              Clear current
            </TooltipButtonTrigger>
            <TooltipButtonContent>
              Remove every registered quest, item, and boost from this
              Environment.
            </TooltipButtonContent>
          </TooltipButton>
          <TooltipButton>
            <TooltipButtonTrigger
              class="environment-sync-action"
              variant="default"
              size="sm"
              aria-busy={syncing()}
              aria-label={syncing() ? "Applying to all" : "Apply to all"}
              disabled={syncing()}
              onClick={() => setApplyDialogOpen(true)}
            >
              {syncing() ? "Applying…" : "Apply to all"}
            </TooltipButtonTrigger>
            <TooltipButtonContent>
              Copy this Environment's settings and lists to every other
              Environment, replacing what's already there.
            </TooltipButtonContent>
          </TooltipButton>
        </div>
      </header>

      <div class="standalone-window__content-frame">
        <div class="standalone-window__content">
          <section class="environment-shell" aria-label="Environment controls">
            <Show when={error()}>
              {(message) => (
                <Alert class="environment-error" variant="error">
                  <AlertDescription>{message()}</AlertDescription>
                </Alert>
              )}
            </Show>

            <div class="environment-grid">
              <SectionPanel
                title="Drops"
                class="environment-panel environment-panel--item"
                count={state().itemNames.length}
                action={
                  <>
                    <AutomationAction
                      enabled={state().automation.drops}
                      label="Drops"
                      onChange={(enabled) =>
                        void updateAutomation("drops", enabled)
                      }
                    />
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      class="environment-clear-action"
                      aria-label="Clear drops"
                      disabled={state().itemNames.length === 0}
                      onClick={() =>
                        void runStateUpdate(
                          props.callbacks?.clearItems?.() ??
                            Promise.resolve(state()),
                        )
                      }
                    >
                      Clear
                    </Button>
                  </>
                }
              >
                <div class="environment-drop-rules">
                  <div class="environment-rule-label">
                    <span id="environment-bucket-label">
                      Unlisted drop policy
                    </span>
                    <HelpTooltip
                      aria-label="About the unlisted drop policy"
                      tooltip='Listed drops and drops in checked categories are accepted. Others are ignored unless "Reject all other drops" is enabled.'
                    />
                  </div>
                  <div
                    class="environment-bucket-grid"
                    role="group"
                    aria-labelledby="environment-bucket-label"
                  >
                    <For each={EnvironmentItemBuckets}>
                      {(bucket) => (
                        <Checkbox
                          class="environment-rule-checkbox"
                          checked={state().itemRules.buckets.includes(bucket)}
                          onChange={(event) =>
                            void toggleItemBucket(
                              bucket,
                              event.currentTarget.checked,
                            )
                          }
                        >
                          {bucketLabels[bucket]}
                        </Checkbox>
                      )}
                    </For>
                    <Checkbox
                      class="environment-rule-checkbox"
                      checked={state().itemRules.rejectElse}
                      onChange={(event) =>
                        void setRejectElse(event.currentTarget.checked)
                      }
                    >
                      Reject all other drops
                    </Checkbox>
                  </div>
                </div>

                <form
                  class="environment-entry"
                  onSubmit={(event) => void addItems(event)}
                >
                  <Input
                    value={itemInput()}
                    placeholder="Item name; another item"
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(event) => setItemInput(event.currentTarget.value)}
                  />
                  <TooltipIconButton
                    type="submit"
                    size="icon"
                    class="environment-icon-action"
                    aria-label="Add drop"
                    variant="default"
                    tooltip="Add drop"
                    disabled={!itemInput().trim()}
                  >
                    <Icon icon="plus" class="button__icon" />
                  </TooltipIconButton>
                </form>

                <div class="environment-list environment-list--drops">
                  <Show
                    when={state().itemNames.length > 0}
                    fallback={<EmptyList label="No drops" />}
                  >
                    <For each={state().itemNames}>
                      {(item) => {
                        const beepEnabled = () =>
                          state().itemNotificationNames.some(
                            (name) => name.toLowerCase() === item.toLowerCase(),
                          );
                        return (
                          <div class="environment-chip environment-chip--drop">
                            <span class="environment-chip__label">{item}</span>
                            <TooltipButton>
                              <TooltipButtonTrigger
                                type="button"
                                class={
                                  beepEnabled()
                                    ? "environment-icon-action environment-beep-button environment-beep-button--active"
                                    : "environment-icon-action environment-beep-button"
                                }
                                size="xs"
                                variant="secondary"
                                aria-label={
                                  beepEnabled()
                                    ? `Disable drop sound for ${item}`
                                    : `Enable drop sound for ${item}`
                                }
                                aria-pressed={beepEnabled()}
                                onClick={() =>
                                  void runStateUpdate(
                                    props.callbacks?.setItemNotification?.(
                                      item,
                                      !beepEnabled(),
                                    ) ?? Promise.resolve(state()),
                                  )
                                }
                              >
                                <Icon icon="bell" class="button__icon" />
                                Sound
                              </TooltipButtonTrigger>
                              <TooltipButtonContent>
                                {beepEnabled()
                                  ? "Stop playing a sound when this item drops."
                                  : "Play a sound when this item drops."}
                              </TooltipButtonContent>
                            </TooltipButton>
                            <IconButton
                              type="button"
                              class="environment-icon-action environment-remove-button"
                              size="icon"
                              variant="ghost"
                              aria-label={`Remove ${item}`}
                              onClick={() =>
                                void runStateUpdate(
                                  props.callbacks?.removeItem?.(item) ??
                                    Promise.resolve(state()),
                                )
                              }
                            >
                              <Icon icon="x" class="button__icon" />
                            </IconButton>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </SectionPanel>

              <SectionPanel
                title="Quests"
                class="environment-panel environment-panel--quest"
                count={state().questIds.length}
                action={
                  <>
                    <AutomationAction
                      enabled={state().automation.quests}
                      label="Quests"
                      onChange={(enabled) =>
                        void updateAutomation("quests", enabled)
                      }
                    />
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      class="environment-clear-action"
                      aria-label="Clear quests"
                      disabled={state().questIds.length === 0}
                      onClick={() =>
                        void runStateUpdate(
                          props.callbacks?.clearQuests?.() ??
                            Promise.resolve(state()),
                        )
                      }
                    >
                      Clear
                    </Button>
                  </>
                }
              >
                <div class="environment-quest-rules">
                  <Checkbox
                    class="environment-rule-checkbox"
                    checked={state().questAutoRegister.rewards}
                    onChange={(event) =>
                      void setQuestAutoRegisterOption(
                        "rewards",
                        event.currentTarget.checked,
                      )
                    }
                  >
                    Auto register rewards
                  </Checkbox>
                  <Checkbox
                    class="environment-rule-checkbox"
                    checked={state().questAutoRegister.requirements}
                    onChange={(event) =>
                      void setQuestAutoRegisterOption(
                        "requirements",
                        event.currentTarget.checked,
                      )
                    }
                  >
                    Auto register requirements
                  </Checkbox>
                </div>

                <form
                  class="environment-entry"
                  onSubmit={(event) => void addQuests(event)}
                >
                  <Input
                    value={questInput()}
                    placeholder="Quest ID; quest:itemID"
                    autocomplete="off"
                    onInput={(event) =>
                      setQuestInput(event.currentTarget.value)
                    }
                  />
                  <TooltipIconButton
                    type="submit"
                    size="icon"
                    class="environment-icon-action"
                    aria-label="Add quest"
                    variant="default"
                    tooltip="Add quest"
                    disabled={!questInput().trim()}
                  >
                    <Icon icon="plus" class="button__icon" />
                  </TooltipIconButton>
                </form>

                <div class="environment-list environment-list--quests">
                  <Show
                    when={state().questIds.length > 0}
                    fallback={<EmptyList label="No quests" />}
                  >
                    <For each={state().questIds}>
                      {(questId) => (
                        <div class="environment-chip environment-chip--quest">
                          <PillButton
                            type="button"
                            class="environment-chip__id environment-quest-id-button"
                            aria-label={`Edit reward item ID for quest ${questId}`}
                            title="Double-click to set reward item ID"
                            onDblClick={() => editQuestReward(questId)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                editQuestReward(questId);
                              }
                            }}
                          >
                            {questId}
                          </PillButton>
                          <Show when={showQuestRewardInput(questId)}>
                            <span class="environment-quest-separator">:</span>
                            <Input
                              ref={(element) =>
                                questRewardInputs.set(questId, element)
                              }
                              class="environment-reward-input"
                              unstyled
                              value={state().questRewards[questId] ?? ""}
                              placeholder="itemID"
                              inputmode="numeric"
                              onKeyDown={(event) =>
                                cancelQuestRewardEdit(event)
                              }
                              onBlur={(event) => {
                                if (canceledQuestRewardEdit) {
                                  canceledQuestRewardEdit = false;
                                  return;
                                }

                                void commitQuestReward(
                                  questId,
                                  event.currentTarget.value,
                                );
                              }}
                            />
                          </Show>
                          <IconButton
                            type="button"
                            class="environment-icon-action environment-remove-button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove quest ${questId}`}
                            onClick={() =>
                              void runStateUpdate(
                                props.callbacks?.removeQuest?.(questId) ??
                                  Promise.resolve(state()),
                              )
                            }
                          >
                            <Icon icon="x" class="button__icon" />
                          </IconButton>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </SectionPanel>

              <SectionPanel
                title="Boosts"
                class="environment-panel environment-panel--boost"
                count={state().boosts.length}
                action={
                  <>
                    <AutomationAction
                      enabled={state().automation.boosts}
                      label="Boosts"
                      onChange={(enabled) =>
                        void updateAutomation("boosts", enabled)
                      }
                    />
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      class="environment-clear-action"
                      aria-label="Clear boosts"
                      disabled={state().boosts.length === 0}
                      onClick={() =>
                        void runStateUpdate(
                          props.callbacks?.clearBoosts?.() ??
                            Promise.resolve(state()),
                        )
                      }
                    >
                      Clear
                    </Button>
                  </>
                }
              >
                <form
                  class="environment-entry"
                  onSubmit={(event) => void addBoosts(event)}
                >
                  <Input
                    value={boostInput()}
                    placeholder="Boost name; another boost"
                    autocomplete="off"
                    spellcheck={false}
                    onInput={(event) =>
                      setBoostInput(event.currentTarget.value)
                    }
                  />
                  <TooltipIconButton
                    type="submit"
                    size="icon"
                    class="environment-icon-action"
                    aria-label="Add boost"
                    variant="default"
                    tooltip="Add boost"
                    disabled={!boostInput().trim()}
                  >
                    <Icon icon="plus" class="button__icon" />
                  </TooltipIconButton>
                </form>

                <div class="environment-list">
                  <Show
                    when={state().boosts.length > 0}
                    fallback={<EmptyList label="No boosts" />}
                  >
                    <For each={state().boosts}>
                      {(boost) => (
                        <div class="environment-chip">
                          <span class="environment-chip__label">{boost}</span>
                          <IconButton
                            type="button"
                            class="environment-icon-action environment-remove-button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${boost}`}
                            onClick={() =>
                              void runStateUpdate(
                                props.callbacks?.removeBoost?.(boost) ??
                                  Promise.resolve(state()),
                              )
                            }
                          >
                            <Icon icon="x" class="button__icon" />
                          </IconButton>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>

                <div class="environment-boost-footer">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-busy={fetchingBoosts() || withdrawingBoosts()}
                    disabled={fetchingBoosts() || withdrawingBoosts()}
                    onClick={() => void fetchBoosts()}
                  >
                    {withdrawingBoosts() ? "Withdrawing…" : "Fetch boosts"}
                  </Button>
                </div>
              </SectionPanel>
            </div>
          </section>
        </div>
      </div>

      <AlertDialog
        open={clearDialogOpen()}
        onOpenChange={(details) => setClearDialogOpen(details.open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this Environment?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every registered quest, item, and boost from this
              Environment. Your settings won't change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void clearAll()}
            >
              Clear Environment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={applyDialogOpen()}
        onOpenChange={(details) => setApplyDialogOpen(details.open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to all Environments?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces every other Environment's settings and lists with
              this Environment's current configuration. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void syncToAll()}
            >
              Apply to all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bankBoostDialogOpen()}
        onOpenChange={(details) => {
          if (!details.open) {
            resetBankBoostDialog();
          }
        }}
      >
        <AlertDialogContent class="environment-bank-boost-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Bank boosts</AlertDialogTitle>
            <AlertDialogDescription>
              Choose boosts to move to your inventory.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div class="environment-bank-boost-body">
            <div class="environment-bank-boost-list">
              <For each={bankBoosts()}>
                {(boost) => (
                  <Checkbox
                    class="environment-bank-boost-option"
                    checked={selectedBankBoostIds().has(boost.itemId)}
                    onChange={(event) =>
                      toggleBankBoost(boost.itemId, event.currentTarget.checked)
                    }
                  >
                    <span class="environment-bank-boost-option__content">
                      <span class="environment-bank-boost-option__name">
                        <span class="environment-bank-boost-option__quantity">
                          {boost.quantity.toLocaleString()}×
                        </span>
                        <span class="environment-bank-boost-option__label">
                          {boost.name}
                        </span>
                      </span>
                      <Show when={boost.alreadyAdded}>
                        <span class="environment-bank-boost-option__meta">
                          Already added
                        </span>
                      </Show>
                    </span>
                  </Checkbox>
                )}
              </For>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={selectedBankBoostIds().size === 0}
              onClick={() => void withdrawSelectedBankBoosts()}
            >
              Withdraw selected
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Connects the fixture-driven Environment view to the Electron bridge. */
export function App(): JSX.Element {
  const environment = selectDesktopBridge(
    window.desktop,
    "environment",
  ).environment;

  return (
    <EnvironmentView
      callbacks={{
        addBoosts: (names) => environment.addBoosts(names),
        addItems: (names) => environment.addItems(names),
        addQuests: (quests) => environment.addQuests(quests),
        clear: () => environment.clear(),
        clearBoosts: () => environment.clearBoosts(),
        clearItems: () => environment.clearItems(),
        clearQuestReward: (questId) => environment.clearQuestReward(questId),
        clearQuests: () => environment.clearQuests(),
        fetchBoosts: () => environment.fetchBoosts(),
        getState: () => environment.getState(),
        onStateChanged: (listener) => environment.onChanged(listener),
        removeBoost: (name) => environment.removeBoost(name),
        removeItem: (name) => environment.removeItem(name),
        removeQuest: (questId) => environment.removeQuest(questId),
        setAutomationEnabled: (capability, enabled) =>
          environment.setAutomationEnabled(capability, enabled),
        setItemNotification: (name, enabled) =>
          environment.setItemNotification(name, enabled),
        setItemRules: (rules) => environment.setItemRules(rules),
        setQuestAutoRegister: (options) =>
          environment.setQuestAutoRegister(options),
        setQuestReward: (questId, rewardItemId) =>
          environment.setQuestReward(questId, rewardItemId),
        syncToAll: () => environment.syncToAll(),
        withdrawBoosts: (itemIds) => environment.withdrawBoosts(itemIds),
      }}
      fixture={{ state: createEmptyEnvironmentState() }}
    />
  );
}
