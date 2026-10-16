/** @jsxImportSource react */
import { Tooltip, TooltipContent, TooltipTrigger } from "@lucent/ui-react";

import type { EnvironmentQuestAutoRegisterOptions } from "@lucent/core/environment";
import {
  AutomationSwitch,
  ClearButton,
  EntryForm,
  RemoveButton,
  RuleGroup,
  SheetSection,
  TagList,
  TogglePill,
  type EnvironmentSectionProps,
} from "./EnvironmentLayout";
import { parseEnvironmentQuestBulkInput } from "./input";
import { useInlineEdit } from "./useInlineEdit";

const AUTO_REGISTER_OPTIONS: readonly {
  readonly label: string;
  readonly option: keyof EnvironmentQuestAutoRegisterOptions;
}[] = [
  { label: "Rewards", option: "rewards" },
  { label: "Requirements", option: "requirements" },
];

type RewardInput =
  | { readonly kind: "clear" }
  | { readonly kind: "invalid" }
  | { readonly kind: "set"; readonly rewardItemId: number };

const parseRewardInput = (value: string): RewardInput => {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { kind: "clear" };
  }
  const rewardItemId = Number(trimmed);
  return Number.isSafeInteger(rewardItemId) && rewardItemId > 0
    ? { kind: "set", rewardItemId }
    : { kind: "invalid" };
};

function QuestTag({
  onRemove,
  onSetReward,
  questId,
  rewardItemId,
}: {
  readonly onRemove: () => void;
  readonly onSetReward: (rewardItemId: number | null) => void;
  readonly questId: number;
  readonly rewardItemId: number | undefined;
}) {
  const edit = useInlineEdit({
    commit: (value) => {
      const input = parseRewardInput(value);
      if (input.kind === "invalid") {
        return "invalid";
      }
      const next = input.kind === "set" ? input.rewardItemId : null;
      if (next !== (rewardItemId ?? null)) {
        onSetReward(next);
      }
      return "saved";
    },
    initialValue: () =>
      rewardItemId === undefined ? "" : String(rewardItemId),
  });

  return (
    <li
      className="environment-tag environment-tag--quest"
      data-editing={edit.editing ? "" : undefined}
    >
      {edit.editing ? (
        <span className="environment-quest">
          {questId}
          <span aria-hidden className="environment-quest__separator">
            ·
          </span>
          <input
            {...edit.inputProps}
            aria-description={
              edit.invalid
                ? "Use a whole number, or leave it empty to remove the reward"
                : undefined
            }
            aria-label={`Reward item ID for quest ${questId}`}
            autoComplete="off"
            className="environment-tag__input"
            inputMode="numeric"
            placeholder="item ID"
            spellCheck={false}
          />
        </span>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={
                    rewardItemId === undefined
                      ? `Set reward for quest ${questId}`
                      : `Change reward for quest ${questId}, currently ${rewardItemId}`
                  }
                  className="environment-quest"
                  onClick={edit.start}
                  ref={edit.triggerRef}
                  type="button"
                />
              }
            >
              {questId}
              {rewardItemId === undefined ? null : (
                <span className="environment-quest__reward">
                  · {rewardItemId}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>
              {rewardItemId === undefined
                ? "Set reward item ID"
                : "Change reward item ID"}
            </TooltipContent>
          </Tooltip>
          <RemoveButton label={`Remove quest ${questId}`} onClick={onRemove} />
        </>
      )}
    </li>
  );
}

export function QuestsSection({
  environment,
  state,
  update,
}: EnvironmentSectionProps) {
  return (
    <SheetSection
      actions={
        <>
          <ClearButton
            disabled={state.questIds.length === 0}
            label="quests"
            onClick={() => void update(() => environment.clearQuests())}
          />
          <AutomationSwitch
            checked={state.automation.quests}
            label="quests"
            onCheckedChange={(enabled) =>
              void update(() =>
                environment.setAutomationEnabled("quests", enabled),
              )
            }
            tooltip="Accept and complete listed quests"
          />
        </>
      }
      count={state.questIds.length}
      id="quests"
      title="Quests"
    >
      <RuleGroup
        help={{
          label: "About auto register",
          text: "Adds quest rewards or required items to Drops.",
        }}
        label="Auto register"
      >
        {AUTO_REGISTER_OPTIONS.map(({ label, option }) => (
          <TogglePill
            key={option}
            onPressedChange={(pressed) =>
              void update(() =>
                environment.setQuestAutoRegister({
                  ...state.questAutoRegister,
                  [option]: pressed,
                }),
              )
            }
            pressed={state.questAutoRegister[option]}
          >
            {label}
          </TogglePill>
        ))}
      </RuleGroup>
      <EntryForm
        label="Add quest"
        onAdd={(value) => {
          const quests = parseEnvironmentQuestBulkInput(value);
          if (quests === null) {
            return "Use quest IDs like 4432, or 4432:11520 to set a reward.";
          }
          if (quests.length > 0) {
            void update(() => environment.addQuests(quests));
          }
          return null;
        }}
        placeholder="4432; 4433:11520"
      />
      <TagList
        count={state.questIds.length}
        emptyText="No quests yet. Add quest IDs above."
      >
        {state.questIds.map((questId) => (
          <QuestTag
            key={questId}
            onRemove={() => void update(() => environment.removeQuest(questId))}
            onSetReward={(rewardItemId) =>
              void update(() =>
                rewardItemId === null
                  ? environment.clearQuestReward(questId)
                  : environment.setQuestReward(questId, rewardItemId),
              )
            }
            questId={questId}
            rewardItemId={state.questRewards[questId]}
          />
        ))}
      </TagList>
    </SheetSection>
  );
}
