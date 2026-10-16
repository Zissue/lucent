import type {
  AuraDelta,
  AuraMutation,
  AuraSeed,
  LiveMonster,
  LivePlayer,
} from "@lucent/game";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { UnknownArray, WireNumber } from "../contract/Coercion";
import type { DiagnosticReporter } from "../contract/Diagnostic";
import type { Event } from "../contract/Event";
import type { ExtensionPacket } from "../contract/Packet";
import { parseCombatEntityReferences } from "../contract/payload/Combat";
import { matchAntiCounterAura } from "../domain/AntiCounter";
import type { AuraTarget, Store } from "../state/Store";

const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);
const as3Int = (value: unknown): number => Number(value) | 0;
const AuraInt = Scalar.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform<number, typeof Scalar.Type>({
      decode: as3Int,
      encode: (value) => value,
    }),
  ),
);
const AuraPayload = Schema.Struct({
  nam: Schema.String,
  cat: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dur: Schema.optionalKey(Schema.NullOr(WireNumber)),
  icon: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isNew: Schema.optionalKey(Scalar),
  persist: Schema.optionalKey(Scalar),
  stk: Schema.optionalKey(Schema.NullOr(AuraInt)),
  t: Schema.optionalKey(Schema.NullOr(Schema.String)),
  val: Schema.optionalKey(
    Schema.NullOr(Schema.Union([WireNumber, Schema.String])),
  ),
  msgOn: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  msgOff: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
});
const AuraChange = Schema.Struct({
  cmd: Schema.Literals([
    "aura+",
    "aura++",
    "aura-",
    "aura--",
    "aura=",
    "aura+p",
    "aura*",
  ]),
  tInf: Schema.String,
  cInf: Schema.optionalKey(Schema.NullOr(Schema.String)),
  aura: Schema.optionalKey(Schema.Unknown),
  auras: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const decodeChange = Schema.decodeUnknownOption(AuraChange);
const decodePayload = Schema.decodeUnknownOption(AuraPayload);
const decodeArray = Schema.decodeUnknownOption(UnknownArray);
const decodeSeedSlots = Schema.decodeUnknownOption(Schema.Array(Scalar));
const decodeSnapshot = Schema.decodeUnknownOption(
  Schema.Struct({
    unm: Schema.String,
    au: Schema.Array(Schema.Unknown),
  }),
);
type AuraPayload = typeof AuraPayload.Type;
type AuraCommand = typeof AuraChange.Type.cmd;

export function decodeAuraSeed(value: unknown): {
  readonly entries: readonly AuraSeed[];
  readonly rejected: readonly unknown[];
} {
  if (value == null) return { entries: [], rejected: [] };
  const array = decodeArray(value);
  if (Option.isNone(array)) return { entries: [], rejected: [value] };
  const entries: AuraSeed[] = [];
  const rejected: unknown[] = [];
  for (const value of array.value) {
    const tuple = decodeArray(value);
    if (
      Option.isNone(tuple) ||
      tuple.value.length < 5 ||
      tuple.value[0] == null
    ) {
      rejected.push(value);
      continue;
    }
    const slots = decodeSeedSlots(tuple.value.slice(0, 6));
    if (Option.isNone(slots)) {
      rejected.push(value);
      continue;
    }
    const [name, icon, remaining, stack, persistent, full] = slots.value;
    const remainingSeconds = Number(remaining);
    const fullSeconds = Number(full);
    entries.push({
      name: String(name),
      icon: String(icon),
      stack: as3Int(stack),
      persistent: as3Int(persistent) === 1,
      timer:
        remainingSeconds > 0 && Number.isFinite(remainingSeconds)
          ? {
              type: "timed",
              remainingSeconds,
              fullSeconds:
                Number.isFinite(fullSeconds) && fullSeconds > remainingSeconds
                  ? fullSeconds
                  : remainingSeconds,
            }
          : { type: "untimed" },
    });
  }
  return { entries, rejected };
}

export function seedAuras(
  entity: LiveMonster | LivePlayer,
  rawAu: unknown,
  nowMs: number,
): {
  readonly changes: readonly AuraDelta[];
  readonly rejected: readonly unknown[];
} {
  const seed = decodeAuraSeed(rawAu);
  return {
    changes: entity.projectAuras(
      { type: "seed", entries: seed.entries },
      nowMs,
    ),
    rejected: seed.rejected,
  };
}

export const messageText = (
  value: string | readonly string[] | null | undefined,
): string | undefined => {
  if (value == null) return undefined;
  const message =
    typeof value === "string" ? value.trim() : value.join(" ").trim();
  return message === "" ? undefined : message;
};

const auraMetadata = (payload: AuraPayload) => ({
  ...(payload.icon == null ? {} : { icon: payload.icon }),
  ...(payload.cat == null ? {} : { category: payload.cat }),
  ...(payload.val == null ? {} : { value: payload.val }),
});

export function auraEvents(
  target: AuraTarget,
  changes: readonly AuraDelta[],
  source?: AuraTarget,
  appliedAtMs?: number,
): readonly Event[] {
  const events: Event[] = [];
  for (const change of changes) {
    const aura = change.type === "removed" ? change.before : change.after;
    if (target.type === "monster" && aura.kind === "active") {
      const match = matchAntiCounterAura(aura.name);
      if (match !== undefined) {
        const counter = {
          monsterMapId: target.id,
          source: "aura" as const,
          triggerId: match.triggerId,
          triggerText: match.triggerText,
        };
        if (change.type === "removed") {
          events.push({ type: "counter-attack-end", ...counter });
        } else if (appliedAtMs !== undefined) {
          events.push({
            type: "counter-attack-start",
            ...counter,
            ...(aura.expiresAt === undefined
              ? {}
              : { durationMs: aura.expiresAt - appliedAtMs }),
          });
        }
      }
    }
    const details = {
      kind: aura.kind,
      name: aura.name,
      targetId: target.id,
      targetType: target.type,
      duration: aura.duration,
      ...(aura.icon === undefined ? {} : { icon: aura.icon }),
      ...(source === undefined
        ? {}
        : { sourceId: source.id, sourceType: source.type }),
    };
    events.push(
      change.type === "removed"
        ? { type: "aura-removed", ...details }
        : {
            type: change.type === "added" ? "aura-added" : "aura-updated",
            ...details,
            stack: aura.stack,
          },
    );
  }
  return events;
}

function auraMutation(
  command: Exclude<AuraCommand, "aura+p" | "aura*">,
  payload: AuraPayload,
): AuraMutation {
  switch (command) {
    case "aura+":
    case "aura++":
      return {
        type: "apply",
        entries: [
          {
            name: payload.nam,
            stack: payload.stk ?? 1,
            timing:
              payload.t === "s" && payload.dur != null && payload.dur > 0
                ? { type: "seconds", duration: payload.dur }
                : { type: "untimed" },
            persistent: Number(payload.persist) === 1,
            restartDuration: Boolean(payload.isNew),
            ...auraMetadata(payload),
          },
        ],
      };
    case "aura-":
    case "aura--":
      return {
        type: "withdraw",
        entries: [
          payload.stk != null && payload.stk > 0
            ? {
                type: "decay",
                name: payload.nam,
                stack: payload.stk,
                ...(payload.dur == null ? {} : { refreshSeconds: payload.dur }),
              }
            : { type: "remove", name: payload.nam },
        ],
      };
    case "aura=":
      return {
        type: "set-stack",
        entries:
          payload.stk == null
            ? []
            : [{ name: payload.nam, stack: payload.stk }],
      };
  }
}

export const projectAuraEvents = Effect.fn("projectAuraEvents")(function* (
  store: Store,
  values: readonly unknown[],
  passiveMode: "replace" | "merge",
  nowMs: number,
  diagnose: DiagnosticReporter,
): Effect.fn.Return<readonly Event[]> {
  const events: Event[] = [];
  for (const value of values) {
    const decoded = decodeChange(value);
    if (Option.isNone(decoded)) {
      yield* diagnose(
        "combat:malformed-aura-change",
        new Error("Ignored malformed aura change"),
        [value],
      );
      continue;
    }
    const change = decoded.value;
    if (change.cmd === "aura*") continue;
    const payloads: AuraPayload[] = [];
    for (const value of change.auras ??
      (change.aura == null ? [] : [change.aura])) {
      const payload = decodePayload(value);
      if (Option.isNone(payload)) {
        yield* diagnose(
          "combat:malformed-aura-payload",
          new Error("Ignored malformed aura payload"),
          [value],
        );
      } else {
        payloads.push(payload.value);
      }
    }
    const source = parseCombatEntityReferences(change.cInf ?? "")[0];
    const target = /^[mp]:\d+$/u.test(change.tInf)
      ? parseCombatEntityReferences(change.tInf)[0]
      : undefined;
    if (target === undefined) continue;
    if (change.cmd === "aura+p") {
      const changes = yield* store.world.projectAuras(
        target,
        {
          type: "passives",
          mode: passiveMode,
          entries: payloads.map((payload) => ({
            name: payload.nam,
            duration: payload.dur ?? 0,
            ...auraMetadata(payload),
          })),
        },
        nowMs,
      );
      events.push(...auraEvents(target, changes, source));
      continue;
    }
    const adding = change.cmd === "aura+" || change.cmd === "aura++";
    for (const payload of payloads) {
      const mutation = auraMutation(change.cmd, payload);
      const changes = yield* store.world.projectAuras(target, mutation, nowMs);
      events.push(
        ...auraEvents(
          target,
          changes,
          source,
          mutation.type === "apply" ? nowMs : undefined,
        ),
      );
      if (change.cmd === "aura=") continue;
      const message = messageText(adding ? payload.msgOn : payload.msgOff);
      if (!message) continue;
      const isSelfOnly = message.startsWith("@");
      const self = isSelfOnly ? yield* store.world.getMe : null;
      if (
        isSelfOnly &&
        (target.type !== "player" || self?.entityId !== target.id)
      )
        continue;
      const normalized = isSelfOnly ? message.slice(1).trim() : message;
      if (normalized !== "")
        events.push({
          type: "update-message",
          message: normalized,
          source: "aura",
          ...(target.type === "monster" ? { monsterMapId: target.id } : {}),
        });
    }
  }
  return events;
});

export const projectStandaloneAuras = Effect.fn("projectStandaloneAuras")(
  function* (
    store: Store,
    packet: ExtensionPacket,
    diagnose: DiagnosticReporter,
  ): Effect.fn.Return<readonly Event[]> {
    if (packet.command !== "auSnap") {
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* projectAuraEvents(
        store,
        [packet.data],
        "replace",
        nowMs,
        diagnose,
      );
    }
    const snapshot = decodeSnapshot(packet.data);
    if (Option.isNone(snapshot)) return [];
    const player = yield* store.world.getPlayer(snapshot.value.unm);
    if (player === null) return [];
    const nowMs = yield* Clock.currentTimeMillis;
    const seed = seedAuras(player, snapshot.value.au, nowMs);
    if (seed.rejected.length > 0)
      yield* diagnose(
        "aura:malformed-seed",
        new Error("Ignored malformed aura seed rows"),
        seed.rejected,
      );
    const target: AuraTarget = { type: "player", id: player.entityId };
    return auraEvents(target, seed.changes);
  },
);
