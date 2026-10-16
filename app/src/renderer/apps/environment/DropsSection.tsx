/** @jsxImportSource react */
import {
  Button,
  Icon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";

import {
  EnvironmentItemBuckets,
  type EnvironmentItemBucket,
  type EnvironmentItemRules,
} from "@lucent/core/environment";
import {
  AutomationSwitch,
  ClearButton,
  EntryForm,
  NameTag,
  RemoveButton,
  RuleGroup,
  SheetSection,
  TagList,
  TogglePill,
  type EnvironmentSectionProps,
} from "./EnvironmentLayout";
import { splitEnvironmentBulkInput } from "./input";
import { renameEntry } from "./rename";

const BUCKET_LABELS: Record<EnvironmentItemBucket, string> = {
  "ac-member": "AC member-only",
  "ac-non-member": "AC non-member",
  "non-ac-member": "Non-AC member-only",
  "non-ac-non-member": "Non-AC non-member",
};

function DropSoundToggle({
  enabled,
  item,
  onToggle,
}: {
  readonly enabled: boolean;
  readonly item: string;
  readonly onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={
              enabled
                ? `Disable drop sound for ${item}`
                : `Enable drop sound for ${item}`
            }
            aria-pressed={enabled}
            className="environment-tag__button environment-sound-toggle"
            onClick={onToggle}
            size="sm"
            square
            variant="ghost"
          >
            <Icon icon="bell" size="sm" />
          </Button>
        }
      />
      <TooltipContent>
        {enabled
          ? "Stop playing a sound when this drops"
          : "Play a sound when this drops"}
      </TooltipContent>
    </Tooltip>
  );
}

export function DropsSection({
  environment,
  state,
  update,
}: EnvironmentSectionProps) {
  const setItemRules = (itemRules: EnvironmentItemRules): void => {
    void update(() => environment.setItemRules(itemRules));
  };

  const toggleBucket = (bucket: EnvironmentItemBucket, pressed: boolean) => {
    const buckets = new Set(state.itemRules.buckets);
    if (pressed) {
      buckets.add(bucket);
    } else {
      buckets.delete(bucket);
    }
    setItemRules({
      ...state.itemRules,
      buckets: EnvironmentItemBuckets.filter((value) => buckets.has(value)),
    });
  };

  const soundEnabled = (item: string): boolean =>
    state.itemNotificationNames.some(
      (name) => name.toLowerCase() === item.toLowerCase(),
    );

  const renameItem = async (from: string, to: string): Promise<void> => {
    const notify = soundEnabled(from);
    const renamed = await renameEntry(update, from, to, {
      add: () => environment.addItems([to]),
      remove: () => environment.removeItem(from),
    });
    if (renamed && notify) {
      await update(() => environment.setItemNotification(to, true));
    }
  };

  return (
    <SheetSection
      actions={
        <>
          <ClearButton
            disabled={state.itemNames.length === 0}
            label="drops"
            onClick={() => void update(() => environment.clearItems())}
          />
          <AutomationSwitch
            checked={state.automation.drops}
            label="drops"
            onCheckedChange={(enabled) =>
              void update(() =>
                environment.setAutomationEnabled("drops", enabled),
              )
            }
            tooltip="Accept listed drops"
          />
        </>
      }
      count={state.itemNames.length}
      id="drops"
      title="Drops"
    >
      <RuleGroup
        help={{
          label: "About unlisted drops",
          text: 'Listed drops and drops in selected categories are accepted. Others are ignored unless "Reject others" is on.',
        }}
        label="Unlisted drops"
      >
        {EnvironmentItemBuckets.map((bucket) => (
          <TogglePill
            key={bucket}
            onPressedChange={(pressed) => toggleBucket(bucket, pressed)}
            pressed={state.itemRules.buckets.includes(bucket)}
          >
            {BUCKET_LABELS[bucket]}
          </TogglePill>
        ))}
        <TogglePill
          danger
          onPressedChange={(rejectElse) =>
            setItemRules({ ...state.itemRules, rejectElse })
          }
          pressed={state.itemRules.rejectElse}
        >
          Reject others
        </TogglePill>
      </RuleGroup>
      <EntryForm
        label="Add drop"
        onAdd={(value) => {
          const items = splitEnvironmentBulkInput(value);
          if (items.length > 0) {
            void update(() => environment.addItems(items));
          }
          return null;
        }}
        placeholder="Dragon Scale; Void Aura"
      />
      <TagList
        count={state.itemNames.length}
        emptyText="No drops yet. Add item names above."
      >
        {state.itemNames.map((item) => (
          <NameTag
            key={item}
            name={item}
            onRename={(next) => void renameItem(item, next)}
          >
            <DropSoundToggle
              enabled={soundEnabled(item)}
              item={item}
              onToggle={() =>
                void update(() =>
                  environment.setItemNotification(item, !soundEnabled(item)),
                )
              }
            />
            <RemoveButton
              label={`Remove ${item}`}
              onClick={() => void update(() => environment.removeItem(item))}
            />
          </NameTag>
        ))}
      </TagList>
    </SheetSection>
  );
}
