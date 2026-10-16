import * as Schema from "effect/Schema";

import { DEFAULT_COMBAT_PROFILE_ID } from "./combatProfiles";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";

export const DEFAULT_FOLLOWER_ATTEMPTS = 3;
export const DEFAULT_FOLLOWER_COMBAT_ENABLED = true;
export const DEFAULT_FOLLOWER_COPY_WALK = false;
export const DEFAULT_FOLLOWER_RETRY_ENABLED = true;

export const FollowerPhaseSchema = Schema.Literals([
  "idle",
  "starting",
  "following",
  "walking",
  "combat",
  "stopped",
]);
export type FollowerPhase = typeof FollowerPhaseSchema.Type;

const AttackPriorityInputSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.Number, Schema.String])),
]);
const LocationFallbackInputSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.String),
]);

export const FollowerStartPayloadSchema = Schema.Struct({
  targetName: Schema.String,
  combatEnabled: Schema.optionalKey(Schema.Boolean),
  copyWalk: Schema.optionalKey(Schema.Boolean),
  retryEnabled: Schema.optionalKey(Schema.Boolean),
  maxAttempts: Schema.optionalKey(Schema.Number),
  selectedProfileId: Schema.optionalKey(Schema.String),
  attackPriority: Schema.optionalKey(AttackPriorityInputSchema),
  lockedZoneFallbacks: Schema.optionalKey(LocationFallbackInputSchema),
  lockedZoneRoomOverride: Schema.optionalKey(Schema.String),
});
export type FollowerStartPayload = typeof FollowerStartPayloadSchema.Type;

export const FollowerConfigSchema = Schema.Struct({
  targetName: TrimmedString,
  combatEnabled: Schema.Boolean,
  copyWalk: Schema.Boolean,
  retryEnabled: Schema.Boolean,
  maxAttempts: PositiveInt,
  selectedProfileId: TrimmedNonEmptyString,
  attackPriority: Schema.Array(
    Schema.Union([PositiveInt, TrimmedNonEmptyString]),
  ),
  lockedZoneFallbacks: Schema.Array(TrimmedNonEmptyString),
  lockedZoneRoomOverride: TrimmedString,
});
export type FollowerConfig = typeof FollowerConfigSchema.Type;

export const FollowerStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  targetName: Schema.String,
  profileId: Schema.optionalKey(Schema.String),
  profileLabel: Schema.optionalKey(Schema.String),
  phase: FollowerPhaseSchema,
  attemptsRemaining: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  lastError: Schema.optionalKey(Schema.String),
  stoppedReason: Schema.optionalKey(Schema.String),
  warning: Schema.optionalKey(Schema.String),
});
export type FollowerState = typeof FollowerStateSchema.Type;

const numericAttackTarget = /^[0-9]+$/u;

const normalizedText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizeAttackTarget = (
  value: number | string,
): number | string | undefined => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
  }

  const token = value.trim();
  if (token === "") {
    return undefined;
  }
  if (!numericAttackTarget.test(token)) {
    return token;
  }

  const id = Number.parseInt(token, 10);
  return id > 0 ? Math.min(Number.MAX_SAFE_INTEGER, id) : undefined;
};

export const parseFollowerAttackPriority = (
  input: FollowerStartPayload["attackPriority"],
): readonly (number | string)[] => {
  const candidates =
    typeof input === "string"
      ? input.split(",")
      : Array.isArray(input)
        ? input
        : [];
  const result: Array<number | string> = [];
  const identities = new Set<string>();

  for (const candidate of candidates) {
    const target = normalizeAttackTarget(candidate);
    if (target === undefined) {
      continue;
    }

    const identity = `${typeof target}:${String(target).toLowerCase()}`;
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    result.push(target);
  }

  return result;
};

export const parseFollowerLocationFallbacks = (
  input: FollowerStartPayload["lockedZoneFallbacks"],
): readonly string[] => {
  const candidates =
    typeof input === "string"
      ? input.split(/\r?\n/u)
      : Array.isArray(input)
        ? input
        : [];
  const result: string[] = [];
  const identities = new Set<string>();

  for (const candidate of candidates) {
    const location = candidate.trim();
    if (location === "") {
      continue;
    }

    const identity = location.toLowerCase();
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    result.push(location);
  }

  return result;
};

export const normalizeFollowerTargetName = (value: unknown): string =>
  normalizedText(value).toLowerCase();

const normalizeAttemptCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FOLLOWER_ATTEMPTS;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(value)));
};

export const normalizeFollowerConfig = (
  input: FollowerStartPayload,
): FollowerConfig => ({
  targetName: normalizeFollowerTargetName(input.targetName),
  combatEnabled: input.combatEnabled ?? DEFAULT_FOLLOWER_COMBAT_ENABLED,
  copyWalk: input.copyWalk ?? DEFAULT_FOLLOWER_COPY_WALK,
  retryEnabled: input.retryEnabled ?? DEFAULT_FOLLOWER_RETRY_ENABLED,
  maxAttempts: normalizeAttemptCount(input.maxAttempts),
  selectedProfileId:
    normalizedText(input.selectedProfileId) || DEFAULT_COMBAT_PROFILE_ID,
  attackPriority: parseFollowerAttackPriority(input.attackPriority),
  lockedZoneFallbacks: parseFollowerLocationFallbacks(
    input.lockedZoneFallbacks,
  ),
  lockedZoneRoomOverride: normalizedText(input.lockedZoneRoomOverride),
});

export const createIdleFollowerState = (): FollowerState => ({
  enabled: false,
  running: false,
  targetName: "",
  phase: "idle",
  attemptsRemaining: DEFAULT_FOLLOWER_ATTEMPTS,
});

const optionalText = (value: unknown): string | undefined => {
  const text = normalizedText(value);
  return text === "" ? undefined : text;
};

export const normalizeFollowerState = (value: unknown): FollowerState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createIdleFollowerState();
  }

  const candidate = value as Record<string, unknown>;
  const rawPhase = candidate["phase"];
  const phase: FollowerPhase =
    rawPhase === "starting" ||
    rawPhase === "following" ||
    rawPhase === "walking" ||
    rawPhase === "combat" ||
    rawPhase === "stopped"
      ? rawPhase
      : "idle";
  const rawAttempts = candidate["attemptsRemaining"];
  const attemptsRemaining =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(rawAttempts)))
      : DEFAULT_FOLLOWER_ATTEMPTS;
  const profileId = optionalText(candidate["profileId"]);
  const profileLabel = optionalText(candidate["profileLabel"]);
  const lastError = optionalText(candidate["lastError"]);
  const stoppedReason = optionalText(candidate["stoppedReason"]);
  const warning = optionalText(candidate["warning"]);

  return {
    enabled: candidate["enabled"] === true,
    running: candidate["running"] === true,
    targetName: normalizeFollowerTargetName(candidate["targetName"]),
    ...(profileId === undefined ? {} : { profileId }),
    ...(profileLabel === undefined ? {} : { profileLabel }),
    phase,
    attemptsRemaining,
    ...(lastError === undefined ? {} : { lastError }),
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
    ...(warning === undefined ? {} : { warning }),
  };
};
