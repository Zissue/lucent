/** @jsxImportSource react */
import {
  Button,
  Field,
  FieldError,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lucent/ui-react";
import { useContext, useEffect, useId, useRef, useState } from "react";

import {
  COMBAT_PROFILE_TEXT_LIMITS,
  type CombatProfile,
  type CombatProfileMessageTrigger,
  type CombatProfileMessageTriggerSource,
} from "@lucent/core/combatProfiles";
import {
  HelpTip,
  InvalidRequestContext,
  NumberField,
  SkillSelect,
} from "./controls";
import {
  MAX_DURATION_MS,
  TRIGGER_SOURCES,
  createTrigger,
  formatDuration,
  insertAt,
  isConditionComplete,
  isTriggerComplete,
  removeAt,
  replaceAt,
  setTriggerCooldown,
  skillName,
  triggerSourceLabel,
} from "./profileModel";
import type { ProfileEditor } from "./useProfileEditor";

type Update = ProfileEditor["update"];

const withTriggers = (
  profile: CombatProfile,
  triggers: readonly CombatProfileMessageTrigger[],
): CombatProfile => {
  const { messageTriggers: _triggers, ...rest } = profile;
  return triggers.length === 0 ? rest : { ...rest, messageTriggers: triggers };
};

type Triggers = readonly CombatProfileMessageTrigger[];

const TRIGGER_COOLDOWN_HELP =
  "Minimum time before this trigger can cast again. Leave empty or 0 to allow every matching message.";

const isIncomplete = (trigger: CombatProfileMessageTrigger | undefined) =>
  trigger !== undefined && !isTriggerComplete(trigger);

export function TriggersSection({
  draft,
  update,
}: {
  readonly draft: CombatProfile;
  readonly update: Update;
}) {
  const triggers = draft.messageTriggers ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [focusMessage, setFocusMessage] = useState(false);
  const editorId = useId();
  const freshTrigger = useRef<CombatProfileMessageTrigger | undefined>(
    undefined,
  );
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | "add" | undefined>(undefined);
  const current =
    selected === null || triggers.length === 0
      ? null
      : Math.min(selected, triggers.length - 1);

  const invalidRequest = useContext(InvalidRequestContext);
  const [seenInvalidRequest, setSeenInvalidRequest] = useState(invalidRequest);
  if (invalidRequest !== seenInvalidRequest) {
    setSeenInvalidRequest(invalidRequest);
    const firstIncomplete = triggers.findIndex(isIncomplete);
    if (firstIncomplete !== -1) {
      setSelected(firstIncomplete);
      setFocusMessage(
        draft.steps.every((step) => step.conditions.every(isConditionComplete)),
      );
    }
  }

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    if (target !== undefined) {
      (target === "add" ? addButton.current : rows.current[target])?.focus();
    }
  });

  const setTriggers = (recipe: (triggers: Triggers) => Triggers) =>
    update((profile) =>
      withTriggers(profile, recipe(profile.messageTriggers ?? [])),
    );

  const select = (index: number | null) => {
    if (
      current !== null &&
      index !== current &&
      triggers[current] === freshTrigger.current
    ) {
      setTriggers((all) => removeAt(all, current));
      const next = index === null || index < current ? index : index - 1;
      setSelected(next);
      pendingFocus.current =
        next ??
        (triggers.length > 1 ? Math.min(current, triggers.length - 2) : "add");
      return;
    }
    setSelected(index);
  };

  const remove = (index: number) => {
    setTriggers((all) => removeAt(all, index));
    setSelected(null);
    pendingFocus.current =
      triggers.length > 1 ? Math.min(index, triggers.length - 2) : "add";
  };

  return (
    <section aria-labelledby="cp-trigger-title" className="cp-group">
      <header className="cp-group__header">
        <h2 className="cp-group__title" id="cp-trigger-title">
          Message triggers
        </h2>
        <Button
          className="cp-builder-add"
          onClick={() => {
            if (current === null || !isIncomplete(triggers[current])) {
              const trigger = createTrigger();
              freshTrigger.current = trigger;
              setTriggers((all) => [...all, trigger]);
              setSelected(triggers.length);
            }
            setFocusMessage(true);
          }}
          ref={addButton}
          size="sm"
          variant="ghost"
        >
          <Icon icon="plus" size="sm" />
          Trigger
        </Button>
      </header>
      <div className="cp-group__card cp-builder cp-trigger-card">
        {triggers.length === 0 ? (
          <p className="cp-builder-empty cp-trigger-empty">
            <span className="cp-builder-empty__title">No message triggers</span>
            Add a trigger to cast a skill when a matching message appears.
          </p>
        ) : (
          <div
            aria-label="Message triggers"
            className="cp-trigger-list"
            role="list"
          >
            {triggers.map((entry, index) => {
              const message = entry.messageIncludes.trim();
              const expanded = index === current;
              return (
                <div
                  className="cp-trigger-item"
                  data-expanded={expanded ? "" : undefined}
                  key={index}
                  role="listitem"
                >
                  <button
                    aria-controls={expanded ? editorId : undefined}
                    aria-expanded={expanded}
                    className="cp-trigger-row"
                    onClick={() => select(expanded ? null : index)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        select(null);
                      } else if (
                        event.key === "Delete" ||
                        event.key === "Backspace"
                      ) {
                        event.preventDefault();
                        if (!event.repeat) {
                          remove(index);
                        }
                      }
                    }}
                    ref={(element) => {
                      rows.current[index] = element;
                    }}
                    type="button"
                  >
                    <span className="cp-trigger-row__line">
                      <span
                        className="cp-trigger-row__message"
                        data-empty={message === "" ? "" : undefined}
                      >
                        {message === "" ? "New trigger" : `"${message}"`}
                      </span>
                      <span className="cp-trigger-row__skill">
                        <span aria-hidden className="cp-trigger-row__arrow">
                          →
                        </span>
                        {skillName(entry.skill)}
                      </span>
                    </span>
                    <span className="cp-trigger-row__meta">
                      {triggerSourceLabel(entry.source)}
                      {entry.cooldownMs === undefined
                        ? null
                        : ` · ${formatDuration(entry.cooldownMs)} cooldown`}
                    </span>
                  </button>
                  {!expanded ? null : (
                    <TriggerEditor
                      focusMessage={focusMessage}
                      id={editorId}
                      index={index}
                      onChange={(next) =>
                        setTriggers((all) => replaceAt(all, index, () => next))
                      }
                      onDuplicate={() => {
                        setTriggers((all) =>
                          insertAt(all, index + 1, { ...entry }),
                        );
                        setSelected(index + 1);
                      }}
                      onFocused={() => setFocusMessage(false)}
                      onRemove={() => remove(index)}
                      trigger={entry}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function TriggerEditor({
  focusMessage,
  id,
  index,
  onChange,
  onDuplicate,
  onFocused,
  onRemove,
  trigger,
}: {
  readonly focusMessage: boolean;
  readonly id: string;
  readonly index: number;
  readonly onChange: (trigger: CombatProfileMessageTrigger) => void;
  readonly onDuplicate: () => void;
  readonly onFocused: () => void;
  readonly onRemove: () => void;
  readonly trigger: CombatProfileMessageTrigger;
}) {
  const message = useRef<HTMLInputElement>(null);
  const invalid =
    useContext(InvalidRequestContext) > 0 && !isTriggerComplete(trigger);

  useEffect(() => {
    if (focusMessage) {
      message.current?.focus();
      onFocused();
    }
  }, [focusMessage, onFocused]);

  return (
    <>
      <div className="cp-trigger-item__actions">
        <IconButton
          disabled={!isTriggerComplete(trigger)}
          focusableWhenDisabled
          label="Duplicate"
          onClick={onDuplicate}
          size="sm"
        >
          <Icon icon="files" size="md" />
        </IconButton>
        <IconButton
          className="cp-builder-remove"
          label="Remove"
          onClick={onRemove}
          size="sm"
        >
          <Icon icon="x" size="md" />
        </IconButton>
      </div>
      <div
        aria-label={`Trigger ${index + 1}`}
        className="cp-trigger-editor"
        id={id}
        role="group"
      >
        <div className="cp-settings">
          <div className="cp-settings__row cp-settings__row--rules">
            <span className="cp-settings__label">Message</span>
            <Field invalid={invalid}>
              <Input
                aria-label="Message"
                maxLength={COMBAT_PROFILE_TEXT_LIMITS.messageTrigger}
                onValueChange={(messageIncludes) =>
                  onChange({ ...trigger, messageIncludes })
                }
                placeholder="message text"
                ref={message}
                size="sm"
                spellCheck={false}
                value={trigger.messageIncludes}
              />
              {invalid ? (
                <FieldError match>Enter text to match</FieldError>
              ) : null}
            </Field>
          </div>
          <div className="cp-settings__row">
            <span className="cp-settings__label">Source</span>
            <Select
              items={TRIGGER_SOURCES}
              onValueChange={(
                source: CombatProfileMessageTriggerSource | null,
              ) => {
                if (source !== null) {
                  onChange({ ...trigger, source });
                }
              }}
              value={trigger.source}
            >
              <SelectTrigger
                aria-label="Source"
                className="cp-settings__select cp-trigger-source"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {TRIGGER_SOURCES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="cp-settings__row">
            <span className="cp-settings__label">Skill</span>
            <SkillSelect
              aria-label="Skill"
              className="cp-settings__select"
              onValueChange={(skill) => onChange({ ...trigger, skill })}
              value={trigger.skill}
            />
          </div>
          <div className="cp-settings__row">
            <span className="cp-settings__label">
              Cooldown
              <HelpTip label="Cooldown" text={TRIGGER_COOLDOWN_HELP} />
            </span>
            <NumberField
              aria-label="Trigger cooldown"
              max={MAX_DURATION_MS}
              onCommit={(cooldownMs) =>
                onChange(setTriggerCooldown(trigger, cooldownMs))
              }
              optional
              placeholder="0"
              unit="ms"
              value={trigger.cooldownMs}
            />
          </div>
        </div>
      </div>
    </>
  );
}
