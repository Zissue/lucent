interface AntiCounterTrigger {
  readonly auraNames: readonly string[];
  readonly auraPatterns: readonly RegExp[];
  readonly messagePatterns: readonly RegExp[];
}

const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const ANTI_COUNTER_TRIGGER_ID = "anti-counter";

const antiCounterTriggers: readonly AntiCounterTrigger[] = [
  {
    auraNames: ["Counter Attack"],
    auraPatterns: [/\bcounter\b.*\battack\b/i],
    messagePatterns: [/prepares\s+a\s+counter\s+attack/i],
  },
];

export interface AntiCounterMatch {
  readonly triggerId: string;
  readonly triggerText: string;
}

export const matchAntiCounterMessage = (
  message: string,
): AntiCounterMatch | undefined => {
  const normalized = normalize(message);
  return !antiCounterTriggers.some((trigger) =>
    trigger.messagePatterns.some((pattern) => pattern.test(normalized)),
  )
    ? undefined
    : {
        triggerId: ANTI_COUNTER_TRIGGER_ID,
        triggerText: message,
      };
};

export const matchAntiCounterAura = (
  name: string,
): AntiCounterMatch | undefined => {
  const normalized = normalize(name);
  return !antiCounterTriggers.some(
    (trigger) =>
      trigger.auraNames.some(
        (candidateName) => normalize(candidateName) === normalized,
      ) || trigger.auraPatterns.some((pattern) => pattern.test(normalized)),
  )
    ? undefined
    : {
        triggerId: ANTI_COUNTER_TRIGGER_ID,
        triggerText: name,
      };
};
