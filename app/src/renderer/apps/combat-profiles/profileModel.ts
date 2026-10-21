import * as Schema from "effect/Schema";

import {
  CombatProfileSchema,
  DEFAULT_COMBAT_PROFILE_DELAY_MS,
  type CombatProfile,
  type CombatProfileCondition,
  type CombatProfileCooldownMode,
  type CombatProfileDefinition,
  type CombatProfileMessageTrigger,
  type CombatProfileMessageTriggerDefinition,
  type CombatProfileMessageTriggerSource,
  type CombatProfileStep,
  type CombatProfileStepDefinition,
  type SkillSlot,
} from "@lucent/core/combatProfiles";

export const SKILL_SLOTS: readonly SkillSlot[] = [0, 1, 2, 3, 4, 5];

export const MAX_DURATION_MS = 60_000;

export const skillName = (slot: SkillSlot): string => `Skill ${slot}`;

export type ConditionType = CombatProfileCondition["type"];

type StatCondition = Extract<
  CombatProfileCondition,
  { readonly type: "self-hp" | "self-mp" | "ally-hp" }
>;

export const CONDITION_TYPES: readonly {
  readonly value: ConditionType;
  readonly label: string;
}[] = [
  { value: "self-hp", label: "Self HP" },
  { value: "self-mp", label: "Self MP" },
  { value: "ally-hp", label: "Any player HP" },
  { value: "self-aura", label: "Self aura" },
  { value: "target-aura", label: "Target aura" },
];

export const isStatCondition = (
  condition: CombatProfileCondition,
): condition is StatCondition =>
  condition.type === "self-hp" ||
  condition.type === "self-mp" ||
  condition.type === "ally-hp";

export const createCondition = (type: ConditionType): CombatProfileCondition =>
  type === "self-aura" || type === "target-aura"
    ? { type, auraName: "", op: ">=", value: 1 }
    : { type, op: "<=", value: type === "self-mp" ? 20 : 50, unit: "percent" };

export const changeConditionType = (
  condition: CombatProfileCondition,
  type: ConditionType,
): CombatProfileCondition => {
  if (condition.type === type) {
    return condition;
  }

  const next = createCondition(type);
  if (isStatCondition(condition) && isStatCondition(next)) {
    return {
      ...next,
      op: condition.op,
      unit: condition.unit,
      value: condition.value,
    };
  }
  if (!isStatCondition(condition) && !isStatCondition(next)) {
    return {
      ...next,
      auraName: condition.auraName,
      op: condition.op,
      value: condition.value,
    };
  }
  return next;
};

const opSymbol = (op: CombatProfileCondition["op"]): string =>
  op === "<=" ? "≤" : "≥";

const statSubject = (type: StatCondition["type"]): string => {
  switch (type) {
    case "self-hp":
      return "HP";
    case "self-mp":
      return "MP";
    case "ally-hp":
      return "Any player HP";
  }
};

const formatConditionValue = (condition: CombatProfileCondition): string =>
  isStatCondition(condition) && condition.unit === "percent"
    ? `${condition.value}%`
    : condition.value.toLocaleString();

export interface ConditionParts {
  readonly subject: string;
  readonly threshold: string;
}

export const conditionParts = (
  condition: CombatProfileCondition,
): ConditionParts => {
  const threshold = `${opSymbol(condition.op)} ${formatConditionValue(condition)}`;
  if (isStatCondition(condition)) {
    return { subject: statSubject(condition.type), threshold };
  }

  const holder = condition.type === "self-aura" ? "Self" : "Target";
  const name =
    condition.auraName.trim() === "" ? "aura" : condition.auraName.trim();
  return { subject: `${holder} ${name}`, threshold };
};

/** Short form for chips, e.g. "HP ≤ 45%" or "Self Temporal Rift ≥ 4". */
export const describeCondition = (
  condition: CombatProfileCondition,
): string => {
  const { subject, threshold } = conditionParts(condition);
  return `${subject} ${threshold}`;
};

export const COOLDOWN_MODES: readonly {
  readonly value: CombatProfileCooldownMode;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "use-if-ready",
    label: "Use if ready",
    description: "Skip skills that are still on cooldown.",
  },
  {
    value: "wait-for-cooldown",
    label: "Wait for cooldown",
    description: "Wait until the skill is ready.",
  },
];

export const STEP_COOLDOWN_MODES: readonly {
  readonly value: CombatProfileCooldownMode | "default";
  readonly label: string;
}[] = [
  { value: "default", label: "Use profile default" },
  { value: "use-if-ready", label: "Skip if unavailable" },
  { value: "wait-for-cooldown", label: "Wait for cooldown" },
];

export const TRIGGER_SOURCES: readonly {
  readonly value: CombatProfileMessageTriggerSource;
  readonly label: string;
}[] = [
  { value: "any", label: "Any" },
  { value: "animation", label: "Animation" },
  { value: "aura", label: "Aura" },
];

export const triggerSourceLabel = (
  source: CombatProfileMessageTriggerSource,
): string =>
  TRIGGER_SOURCES.find((option) => option.value === source)?.label ?? source;

export const formatDuration = (ms: number): string =>
  `${ms.toLocaleString()} ms`;

export const clampInt = (value: number, min: number, max: number): number =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : min;

export const moveItem = <T>(
  items: readonly T[],
  from: number,
  to: number,
): readonly T[] => {
  if (
    from === to ||
    from < 0 ||
    from >= items.length ||
    to < 0 ||
    to >= items.length
  ) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

export const replaceAt = <T>(
  items: readonly T[],
  index: number,
  update: (item: T) => T,
): readonly T[] =>
  items.map((item, current) => (current === index ? update(item) : item));

export const removeAt = <T>(items: readonly T[], index: number): readonly T[] =>
  items.filter((_, current) => current !== index);

export const insertAt = <T>(
  items: readonly T[],
  index: number,
  item: T,
): readonly T[] => [...items.slice(0, index), item, ...items.slice(index)];

export const cloneStep = (step: CombatProfileStep): CombatProfileStep => ({
  ...step,
  conditions: step.conditions.map((condition) => ({ ...condition })),
});

export const setStepPriority = (
  step: CombatProfileStep,
  priority: boolean,
): CombatProfileStep => {
  const { priority: _priority, ...rest } = step;
  return priority ? { ...rest, priority: true } : rest;
};

export const setStepCooldownMode = (
  step: CombatProfileStep,
  mode: CombatProfileCooldownMode | undefined,
): CombatProfileStep => {
  const { cooldownMode: _cooldownMode, ...rest } = step;
  return mode === undefined ? rest : { ...rest, cooldownMode: mode };
};

export const setStepWait = (
  step: CombatProfileStep,
  waitMs: number,
): CombatProfileStep => {
  const { waitMs: _waitMs, ...rest } = step;
  const clamped = clampInt(waitMs, 0, MAX_DURATION_MS);
  return clamped > 0 ? { ...rest, waitMs: clamped } : rest;
};

export const setTriggerCooldown = (
  trigger: CombatProfileMessageTrigger,
  cooldownMs: number,
): CombatProfileMessageTrigger => {
  const { cooldownMs: _cooldownMs, ...rest } = trigger;
  const clamped = clampInt(cooldownMs, 0, MAX_DURATION_MS);
  return clamped > 0 ? { ...rest, cooldownMs: clamped } : rest;
};

export const createStep = (skill: SkillSlot): CombatProfileStep => ({
  skill,
  conditions: [],
});

export const createTrigger = (): CombatProfileMessageTrigger => ({
  messageIncludes: "",
  skill: 5,
  source: "any",
});

export const createBlankProfile = (
  id: string,
  label: string,
): CombatProfile => ({
  id,
  label,
  delayMs: DEFAULT_COMBAT_PROFILE_DELAY_MS,
  cooldownMode: "use-if-ready",
  steps: ([1, 2, 3, 4] as const).map(createStep),
});

export const nextProfileLabel = (
  profiles: readonly CombatProfile[],
): string => {
  const labels = new Set(profiles.map((profile) => profile.label));
  if (!labels.has("New Profile")) {
    return "New Profile";
  }

  let index = 2;
  while (labels.has(`New Profile ${index}`)) {
    index += 1;
  }
  return `New Profile ${index}`;
};

const hasClassName = (classNames: readonly string[], className: string) =>
  classNames.some(
    (candidate) =>
      candidate.localeCompare(className, undefined, {
        sensitivity: "accent",
      }) === 0,
  );

export const appendClassName = (
  classNames: readonly string[],
  value: string,
): readonly string[] => {
  const className = value.trim();
  if (className === "" || hasClassName(classNames, className)) {
    return classNames;
  }

  return [...classNames, className];
};

export const renameClassName = (
  classNames: readonly string[],
  index: number,
  value: string,
): readonly string[] => {
  const className = value.trim();
  if (className === classNames[index]) {
    return classNames;
  }
  const others = removeAt(classNames, index);
  return className === "" || hasClassName(others, className)
    ? others
    : replaceAt(classNames, index, () => className);
};

export interface ClassNameEdit {
  readonly index: number;
  readonly text: string;
}

export const withClassNameEdit = (
  profile: CombatProfile,
  edit: ClassNameEdit | undefined,
): CombatProfile => {
  const classNames = profile.classNames ?? [];
  const next =
    edit === undefined
      ? classNames
      : renameClassName(classNames, edit.index, edit.text);
  if (next === classNames) {
    return profile;
  }
  const { classNames: _classNames, ...rest } = profile;
  return next.length === 0 ? rest : { ...rest, classNames: next };
};

export const withPendingClassName = (
  profile: CombatProfile,
  value: string,
): CombatProfile => {
  const classNames = profile.classNames ?? [];
  const next = appendClassName(classNames, value);
  return next === classNames ? profile : { ...profile, classNames: next };
};

export const isConditionComplete = (
  condition: CombatProfileCondition,
): boolean => isStatCondition(condition) || condition.auraName.trim() !== "";

export const isTriggerComplete = (
  trigger: CombatProfileMessageTrigger,
): boolean => trigger.messageIncludes.trim() !== "";

export const hasIncompleteRows = (profile: CombatProfile): boolean =>
  profile.steps.some((step) => !step.conditions.every(isConditionComplete)) ||
  !(profile.messageTriggers ?? []).every(isTriggerComplete);

const sameProfile = Schema.toEquivalence(CombatProfileSchema);

export const isUnsaved = (
  draft: CombatProfile,
  saved: CombatProfile | undefined,
): boolean =>
  saved === undefined || (draft !== saved && !sameProfile(draft, saved));

/** Drops half-written rows and clamps numbers so the draft passes the IPC schema. */
export const toSavableProfile = (
  draft: CombatProfile,
  fallbackLabel: string,
): CombatProfile => {
  const classNames = (draft.classNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const consumable = draft.consumable?.trim() ?? "";
  const triggers = (draft.messageTriggers ?? [])
    .filter(isTriggerComplete)
    .map((trigger) => ({
      ...trigger,
      messageIncludes: trigger.messageIncludes.trim(),
    }));

  return {
    id: draft.id,
    label: draft.label.trim() || fallbackLabel,
    ...(classNames.length === 0 ? {} : { classNames }),
    ...(consumable === "" ? {} : { consumable }),
    delayMs: clampInt(draft.delayMs, 0, MAX_DURATION_MS),
    cooldownMode: draft.cooldownMode,
    ...(draft.resetSkillIndexOnTargetDeath === true
      ? { resetSkillIndexOnTargetDeath: true }
      : {}),
    steps: draft.steps.map((step) => {
      const savable = {
        ...step,
        conditions: step.conditions
          .filter(isConditionComplete)
          .map((condition) =>
            isStatCondition(condition)
              ? {
                  ...condition,
                  value: clampInt(
                    condition.value,
                    0,
                    condition.unit === "percent" ? 100 : 999_999,
                  ),
                }
              : {
                  ...condition,
                  auraName: condition.auraName.trim(),
                  value: clampInt(condition.value, 0, 999),
                },
          ),
      };
      return savable.cooldownMode === draft.cooldownMode
        ? setStepCooldownMode(savable, undefined)
        : savable;
    }),
    ...(triggers.length === 0 ? {} : { messageTriggers: triggers }),
  };
};

const jsIdentifierPattern = /^[A-Za-z_$][\w$]*$/u;

const formatJsLiteral = (value: unknown, depth = 0): string => {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[\n${value
          .map((item) => `${childIndent}${formatJsLiteral(item, depth + 1)}`)
          .join(",\n")}\n${indent}]`;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(
      ([, entry]) => entry !== undefined,
    );
    return entries.length === 0
      ? "{}"
      : `{\n${entries
          .map(
            ([key, entry]) =>
              `${childIndent}${jsIdentifierPattern.test(key) ? key : JSON.stringify(key)}: ${formatJsLiteral(entry, depth + 1)}`,
          )
          .join(",\n")}\n${indent}}`;
  }

  return JSON.stringify(value) ?? "undefined";
};

const toScriptStep = (
  step: CombatProfileStep,
): CombatProfileStepDefinition => ({
  skill: step.skill,
  conditions: step.conditions.map((condition) => ({ ...condition })),
  ...(step.priority === true ? { priority: true } : {}),
  ...(step.cooldownMode === undefined
    ? {}
    : { cooldownMode: step.cooldownMode }),
  ...(step.waitMs === undefined ? {} : { waitMs: step.waitMs }),
});

const toScriptTrigger = (
  trigger: CombatProfileMessageTrigger,
): CombatProfileMessageTriggerDefinition => ({
  messageIncludes: trigger.messageIncludes,
  skill: trigger.skill,
  source: trigger.source,
  ...(trigger.cooldownMs === undefined
    ? {}
    : { cooldownMs: trigger.cooldownMs }),
});

const toScriptDefinition = (
  profile: CombatProfile,
): CombatProfileDefinition => ({
  delayMs: profile.delayMs,
  cooldownMode: profile.cooldownMode,
  ...(profile.consumable === undefined
    ? {}
    : { consumable: profile.consumable }),
  ...(profile.resetSkillIndexOnTargetDeath === true
    ? { resetSkillIndexOnTargetDeath: true }
    : {}),
  steps: profile.steps.map(toScriptStep),
  ...(profile.messageTriggers === undefined ||
  profile.messageTriggers.length === 0
    ? {}
    : { messageTriggers: profile.messageTriggers.map(toScriptTrigger) }),
});

export const formatProfileSnippet = (profile: CombatProfile): string =>
  `profile: ${formatJsLiteral(toScriptDefinition(profile))}`;

/** Full description for tooltips and screen readers. */
export const describeStep = (
  step: CombatProfileStep,
  defaultMode: CombatProfileCooldownMode,
): string =>
  [
    skillName(step.skill),
    ...(step.priority === true ? ["Priority"] : []),
    ...step.conditions.map(describeCondition),
    ...(step.waitMs === undefined || step.waitMs === 0
      ? []
      : [`Delay ${formatDuration(step.waitMs)}`]),
    ...(step.cooldownMode === undefined || step.cooldownMode === defaultMode
      ? []
      : [
          step.cooldownMode === "wait-for-cooldown"
            ? "Wait for cooldown"
            : "Skip if unavailable",
        ]),
  ].join(" · ");
