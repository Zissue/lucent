/** @jsxImportSource react */
import {
  Button,
  Icon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@lucent/ui-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  COMBAT_PROFILE_TEXT_LIMITS,
  type CombatProfile,
  type CombatProfileCondition,
  type CombatProfileCooldownMode,
  type CombatProfileStep,
  type SkillSlot,
} from "@lucent/core/combatProfiles";
import {
  CONDITION_TYPES,
  COOLDOWN_MODES,
  MAX_DURATION_MS,
  SKILL_SLOTS,
  STEP_COOLDOWN_MODES,
  appendClassName,
  changeConditionType,
  clampInt,
  conditionParts,
  createCondition,
  describeCondition,
  isConditionComplete,
  isStatCondition,
  removeAt,
  renameClassName,
  replaceAt,
  setStepCooldownMode,
  setStepPriority,
  setStepWait,
  type ClassNameEdit,
  type ConditionType,
} from "./profileModel";

const SKILL_ITEMS = SKILL_SLOTS.map((slot) => ({
  value: slot,
  label: String(slot),
}));

export function SkillKey({
  size = "md",
  skill,
}: {
  readonly size?: "md" | "lg";
  readonly skill: SkillSlot;
}) {
  return (
    <span aria-hidden className="cp-key" data-size={size} data-skill={skill}>
      {skill}
    </span>
  );
}

export function SkillSelect({
  "aria-label": ariaLabel,
  className,
  onValueChange,
  value,
}: {
  readonly "aria-label": string;
  readonly className?: string;
  readonly onValueChange: (skill: SkillSlot) => void;
  readonly value: SkillSlot;
}) {
  return (
    <Select
      items={SKILL_ITEMS}
      onValueChange={(next: SkillSlot | null) => {
        if (next !== null) {
          onValueChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={
          className === undefined
            ? "cp-skill-select"
            : `cp-skill-select ${className}`
        }
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SKILL_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Segmented<Value extends string>({
  "aria-label": ariaLabel,
  onValueChange,
  options,
  value,
}: {
  readonly "aria-label": string;
  readonly onValueChange: (value: Value) => void;
  readonly options: readonly {
    readonly value: Value;
    readonly label: ReactNode;
  }[];
  readonly value: Value;
}) {
  const name = useId();
  return (
    <div aria-label={ariaLabel} className="cp-segmented" role="radiogroup">
      {options.map((option) => (
        <label className="cp-segmented__option" key={option.value}>
          <input
            checked={option.value === value}
            className="cp-segmented__input"
            name={name}
            onChange={() => onValueChange(option.value)}
            type="radio"
            value={option.value}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Commits clamped values as you type. Empty means unset when optional; otherwise blur restores the last value. */
export function NumberField({
  "aria-label": ariaLabel,
  className,
  max,
  onCommit,
  optional = false,
  placeholder,
  unit,
  value,
}: {
  readonly "aria-label": string;
  readonly className?: string;
  readonly max: number;
  readonly onCommit: (value: number) => void;
  readonly optional?: boolean;
  readonly placeholder?: string | undefined;
  readonly unit?: string | undefined;
  readonly value: number | undefined;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setText(value === undefined ? "" : String(value));
    }
  }, [value]);

  const commit = () => {
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed)) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    const next = clampInt(parsed, 0, max);
    setText(String(next));
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <span
      className={
        className === undefined ? "cp-number" : `cp-number ${className}`
      }
    >
      <Input
        aria-label={ariaLabel}
        inputMode="numeric"
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter" || event.key === "Escape") {
            commit();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const current = Number.parseInt(text, 10) || 0;
            const next = clampInt(
              current + (event.key === "ArrowUp" ? step : -step),
              0,
              max,
            );
            setText(String(next));
            onCommit(next);
          }
        }}
        onValueChange={(raw) => {
          const digits = raw.replace(/\D/g, "");
          if (digits === "") {
            setText("");
            if (optional && value !== undefined) {
              onCommit(0);
            }
            return;
          }
          const next = clampInt(Number.parseInt(digits, 10), 0, max);
          setText(next === max ? String(max) : digits);
          if (next !== value) {
            onCommit(next);
          }
        }}
        placeholder={placeholder}
        size="sm"
        value={text}
      />
      {unit === undefined ? null : (
        <span aria-hidden className="cp-number__unit">
          {unit}
        </span>
      )}
    </span>
  );
}

/** How many times Save was blocked by a half-filled row; non-zero means highlight empty required fields. */
export const InvalidRequestContext = createContext(0);

function ConditionFields({
  condition,
  onChange,
}: {
  readonly condition: CombatProfileCondition;
  readonly onChange: (condition: CombatProfileCondition) => void;
}) {
  const stat = isStatCondition(condition);
  const invalid =
    useContext(InvalidRequestContext) > 0 && !isConditionComplete(condition);
  return (
    <div className="cp-fields">
      <Select
        items={CONDITION_TYPES}
        onValueChange={(type: ConditionType | null) => {
          if (type !== null) {
            onChange(changeConditionType(condition, type));
          }
        }}
        value={condition.type}
      >
        <SelectTrigger aria-label="Condition" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONDITION_TYPES.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {stat ? null : (
        <Input
          aria-invalid={invalid || undefined}
          aria-label="Aura name"
          autoFocus
          data-invalid={invalid ? "" : undefined}
          maxLength={COMBAT_PROFILE_TEXT_LIMITS.auraName}
          onValueChange={(auraName) => onChange({ ...condition, auraName })}
          placeholder="Aura name"
          size="sm"
          spellCheck={false}
          value={condition.auraName}
        />
      )}
      <div className="cp-fields__row">
        <Segmented
          aria-label="Operator"
          onValueChange={(op) => onChange({ ...condition, op })}
          options={[
            { value: "<=", label: "≤" },
            { value: ">=", label: "≥" },
          ]}
          value={condition.op}
        />
        <NumberField
          aria-label="Value"
          className="cp-fields__value"
          max={stat ? (condition.unit === "percent" ? 100 : 999_999) : 999}
          onCommit={(value) => onChange({ ...condition, value })}
          value={condition.value}
        />
        {stat ? (
          <Segmented
            aria-label="Unit"
            onValueChange={(unit) =>
              onChange({
                ...condition,
                unit,
                value:
                  unit === "percent"
                    ? Math.min(condition.value, 100)
                    : condition.value,
              })
            }
            options={[
              { value: "percent", label: "%" },
              { value: "value", label: "Value" },
            ]}
            value={condition.unit}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ConditionLabel({
  condition,
}: {
  readonly condition: CombatProfileCondition;
}) {
  const { subject, threshold } = conditionParts(condition);
  return (
    <span className="cp-condition">
      <span className="cp-condition__subject">{subject}</span>
      <span className="cp-condition__threshold">{threshold}</span>
    </span>
  );
}

function ConditionChip({
  autoOpen = false,
  condition,
  onChange,
  onRemove,
}: {
  readonly autoOpen?: boolean;
  readonly condition: CombatProfileCondition;
  readonly onChange: (condition: CombatProfileCondition) => void;
  readonly onRemove: () => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  const created = useRef(autoOpen ? condition : undefined);
  const errorId = useId();
  const incomplete = !isConditionComplete(condition);
  const invalid = useContext(InvalidRequestContext) > 0 && incomplete;
  return (
    <>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && incomplete && condition === created.current) {
            onRemove();
          }
        }}
        open={open}
      >
        <PopoverTrigger
          aria-describedby={invalid ? errorId : undefined}
          aria-invalid={invalid || undefined}
          className="cp-chip"
          data-incomplete={incomplete ? "" : undefined}
          data-invalid={invalid ? "" : undefined}
          render={<button title={describeCondition(condition)} type="button" />}
        >
          <ConditionLabel condition={condition} />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Rule settings"
          className="cp-popover"
        >
          <ConditionFields condition={condition} onChange={onChange} />
          <div className="cp-popover__footer">
            <Button
              className="cp-danger-ghost"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              size="sm"
              variant="ghost"
            >
              Remove rule
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {invalid ? (
        <span className="cp-library-sr" id={errorId}>
          Aura name required
        </span>
      ) : null}
    </>
  );
}

function AddConditionMenu({
  onAdd,
}: {
  readonly onAdd: (type: ConditionType) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button className="cp-add-condition" size="sm" variant="ghost" />
        }
      >
        <Icon icon="plus" size="xs" />
        Rule
      </MenuTrigger>
      <MenuContent>
        {CONDITION_TYPES.map((option) => (
          <MenuItem key={option.value} onClick={() => onAdd(option.value)}>
            {option.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function StepSettings({
  onChange,
  step,
}: {
  readonly onChange: (step: CombatProfileStep) => void;
  readonly step: CombatProfileStep;
}) {
  const [fresh, setFresh] = useState<number | null>(null);
  const rules = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | "add" | undefined>(undefined);

  useEffect(() => {
    if (fresh !== null) {
      setFresh(null);
    }
  }, [fresh]);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    if (target !== undefined) {
      rules.current
        ?.querySelectorAll<HTMLElement>(
          target === "add" ? ".cp-add-condition" : ".cp-chip",
        )
        [target === "add" ? 0 : target]?.focus();
    }
  });

  return (
    <div className="cp-settings">
      <div className="cp-settings__row cp-settings__row--rules">
        <span className="cp-settings__label">Rules</span>
        <div className="cp-settings__rules" ref={rules}>
          {step.conditions.map((condition, conditionIndex) => (
            <ConditionChip
              autoOpen={fresh === conditionIndex}
              condition={condition}
              key={conditionIndex}
              onChange={(next) =>
                onChange({
                  ...step,
                  conditions: replaceAt(
                    step.conditions,
                    conditionIndex,
                    () => next,
                  ),
                })
              }
              onRemove={() => {
                pendingFocus.current =
                  step.conditions.length > 1
                    ? Math.min(conditionIndex, step.conditions.length - 2)
                    : "add";
                onChange({
                  ...step,
                  conditions: removeAt(step.conditions, conditionIndex),
                });
              }}
            />
          ))}
          <AddConditionMenu
            onAdd={(type) => {
              setFresh(step.conditions.length);
              onChange({
                ...step,
                conditions: [...step.conditions, createCondition(type)],
              });
            }}
          />
        </div>
      </div>
      <div className="cp-settings__row">
        <span className="cp-settings__label">Cooldown</span>
        <StepCooldownSelect
          className="cp-settings__select"
          onChange={(next) => onChange(next)}
          step={step}
        />
      </div>
      <div className="cp-settings__row">
        <span className="cp-settings__label">Delay</span>
        <NumberField
          aria-label="Delay after this skill"
          max={MAX_DURATION_MS}
          onCommit={(waitMs) => onChange(setStepWait(step, waitMs))}
          optional
          placeholder="0"
          unit="ms"
          value={step.waitMs}
        />
      </div>
      <div className="cp-settings__row">
        <span className="cp-settings__label">
          Priority
          <HelpTip label="Priority" text={PRIORITY_HELP} />
        </span>
        <Switch
          aria-label="Priority"
          checked={step.priority === true}
          onCheckedChange={(priority) =>
            onChange(setStepPriority(step, priority))
          }
          size="sm"
        />
      </div>
    </div>
  );
}

const PRIORITY_HELP =
  "This skill can interrupt the normal rotation. On the next normal cast, the rotation resumes where it left off.";

function StepCooldownSelect({
  className,
  onChange,
  step,
}: {
  readonly className?: string;
  readonly onChange: (step: CombatProfileStep) => void;
  readonly step: CombatProfileStep;
}) {
  const value: CombatProfileCooldownMode | "default" =
    step.cooldownMode ?? "default";
  return (
    <Select
      items={STEP_COOLDOWN_MODES}
      onValueChange={(mode: CombatProfileCooldownMode | "default" | null) => {
        if (mode !== null) {
          onChange(
            setStepCooldownMode(step, mode === "default" ? undefined : mode),
          );
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label="Cooldown" className={className} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STEP_COOLDOWN_MODES.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function HelpTip({
  label,
  text,
}: {
  readonly label: string;
  readonly text: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`${label} help`}
            className="cp-help"
            size="sm"
            square
            type="button"
            variant="ghost"
          />
        }
      >
        <Icon icon="info" size="sm" />
      </TooltipTrigger>
      <TooltipContent className="cp-help__content">{text}</TooltipContent>
    </Tooltip>
  );
}

const COLLAPSED_CLASS_LIMIT = 8;

export function ClassTagsField({
  "aria-labelledby": labelledBy,
  classNames,
  editing,
  inputValue,
  onChange,
  onEditingChange,
  onFinishEditing,
  onInputValueChange,
}: {
  readonly "aria-labelledby"?: string;
  readonly classNames: readonly string[];
  readonly editing: ClassNameEdit | undefined;
  readonly inputValue: string;
  readonly onChange: (classNames: readonly string[]) => void;
  readonly onEditingChange: (edit: ClassNameEdit) => void;
  readonly onFinishEditing: (save: boolean) => void;
  readonly onInputValueChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const editingIndex = editing?.index;
  const input = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const labels = useRef<(HTMLButtonElement | null)[]>([]);
  const pendingFocus = useRef<number | "input" | undefined>(undefined);
  const collapsible = classNames.length > COLLAPSED_CLASS_LIMIT;
  const visible =
    collapsible && !expanded
      ? classNames.slice(0, COLLAPSED_CLASS_LIMIT)
      : classNames;
  const commit = () => {
    const next = appendClassName(classNames, inputValue);
    onInputValueChange("");
    if (next !== classNames) {
      onChange(next);
    }
  };

  useEffect(() => {
    if (editingIndex !== undefined) {
      editInput.current?.focus();
      editInput.current?.select();
    }
  }, [editingIndex]);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    if (target !== undefined) {
      (target === "input"
        ? input.current
        : (labels.current[target] ?? input.current)
      )?.focus();
    }
  });

  const finishEditing = (save: boolean, refocus: boolean) => {
    if (editing === undefined) {
      return;
    }
    if (refocus) {
      const next = save
        ? renameClassName(classNames, editing.index, editing.text)
        : classNames;
      pendingFocus.current =
        next.length < classNames.length ? "input" : editing.index;
    }
    onFinishEditing(save);
  };

  return (
    <div
      className="cp-tags"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          input.current?.focus();
        }
      }}
    >
      {visible.map((name, index) =>
        editing !== undefined && index === editing.index ? (
          <span className="cp-tag" data-editing="" key={name}>
            <input
              aria-label="Class name"
              className="cp-tag__edit"
              maxLength={COMBAT_PROFILE_TEXT_LIMITS.className}
              onBlur={() => finishEditing(true, false)}
              onChange={(event) =>
                onEditingChange({
                  index: editing.index,
                  text: event.currentTarget.value,
                })
              }
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  finishEditing(true, true);
                } else if (event.key === "Escape") {
                  finishEditing(false, true);
                } else if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  finishEditing(true, true);
                }
              }}
              ref={editInput}
              spellCheck={false}
              value={editing.text}
            />
          </span>
        ) : (
          <span className="cp-tag" key={name}>
            <button
              aria-label={`Edit ${name}`}
              className="cp-tag__label"
              onClick={() =>
                onEditingChange({ index, text: classNames[index] ?? name })
              }
              ref={(node) => {
                labels.current[index] = node;
              }}
              title={name}
              type="button"
            >
              {name}
            </button>
            <button
              aria-label={`Remove ${name}`}
              className="cp-tag__remove"
              onClick={() => {
                pendingFocus.current =
                  classNames.length > 1
                    ? Math.min(index, classNames.length - 2)
                    : "input";
                onChange(removeAt(classNames, index));
              }}
              type="button"
            >
              <Icon icon="x" size="xs" />
            </button>
          </span>
        ),
      )}
      {collapsible ? (
        <button
          aria-expanded={expanded}
          className="cp-tags__more"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded
            ? "Show less"
            : `+${classNames.length - COLLAPSED_CLASS_LIMIT} more`}
        </button>
      ) : null}
      <input
        aria-labelledby={labelledBy}
        className="cp-tags__input"
        maxLength={COMBAT_PROFILE_TEXT_LIMITS.className}
        onBlur={commit}
        onChange={(event) => onInputValueChange(event.currentTarget.value)}
        onFocus={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (
            event.key === "Backspace" &&
            !event.repeat &&
            inputValue === "" &&
            classNames.length > 0
          ) {
            onChange(classNames.slice(0, -1));
          }
        }}
        placeholder="Add class…"
        ref={input}
        spellCheck={false}
        value={inputValue}
      />
    </div>
  );
}

export function Group({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="cp-group">
      <header className="cp-group__header">
        <div className="cp-group__heading">
          <h2 className="cp-group__title" id={titleId}>
            {title}
          </h2>
        </div>
      </header>
      <div className="cp-group__card">{children}</div>
    </section>
  );
}

function Row({
  children,
  help,
  label,
}: {
  readonly children: (labelId: string) => ReactNode;
  readonly help?: string;
  readonly label: string;
}) {
  const labelId = useId();
  return (
    <div className="cp-row">
      <div className="cp-row__text">
        <span className="cp-row__label">
          <span id={labelId}>{label}</span>
          {help === undefined ? null : <HelpTip label={label} text={help} />}
        </span>
      </div>
      <div className="cp-row__control">{children(labelId)}</div>
    </div>
  );
}

export function BehaviorRows({
  draft,
  onChange,
}: {
  readonly draft: CombatProfile;
  readonly onChange: (recipe: (draft: CombatProfile) => CombatProfile) => void;
}) {
  return (
    <>
      <Row label="Cooldown mode">
        {(labelId) => (
          <Select
            items={COOLDOWN_MODES}
            onValueChange={(cooldownMode: CombatProfileCooldownMode | null) => {
              if (cooldownMode !== null) {
                onChange((current) => ({ ...current, cooldownMode }));
              }
            }}
            value={draft.cooldownMode}
          >
            <SelectTrigger
              aria-labelledby={labelId}
              className="cp-row__select"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {COOLDOWN_MODES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Row>
      <Row label="Delay">
        {() => (
          <NumberField
            aria-label="Delay between skills"
            max={MAX_DURATION_MS}
            onCommit={(delayMs) =>
              onChange((current) => ({ ...current, delayMs }))
            }
            unit="ms"
            value={draft.delayMs}
          />
        )}
      </Row>
      <Row
        help="Equips this inventory item before combat. The first running profile controls preflight equipment."
        label="Skill 5 item"
      >
        {(labelId) => (
          <Input
            aria-labelledby={labelId}
            className="cp-row__input"
            maxLength={COMBAT_PROFILE_TEXT_LIMITS.consumable}
            onValueChange={(consumable) =>
              onChange(({ consumable: _consumable, ...rest }) =>
                consumable.trim() === "" ? rest : { ...rest, consumable },
              )
            }
            placeholder="Potent Honor Potion"
            size="sm"
            spellCheck={false}
            value={draft.consumable ?? ""}
          />
        )}
      </Row>
      <Row
        help="Restart at the first matching skill when the active target dies."
        label="Reset rotation on target death"
      >
        {(labelId) => (
          <Switch
            aria-labelledby={labelId}
            checked={draft.resetSkillIndexOnTargetDeath === true}
            onCheckedChange={(reset) =>
              onChange((current) => {
                const { resetSkillIndexOnTargetDeath: _reset, ...rest } =
                  current;
                return reset
                  ? { ...rest, resetSkillIndexOnTargetDeath: true }
                  : rest;
              })
            }
          />
        )}
      </Row>
    </>
  );
}
