import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Event } from "../contract/Event";
import {
  ignoreDiagnostic,
  type DiagnosticReporter,
} from "../contract/Diagnostic";
import { WireNumber } from "../contract/Coercion";
import type { ExtensionPacket, ServerPacket } from "../contract/Packet";
import { parseCombatEntityReferences } from "../contract/payload/Combat";
import { matchAntiCounterMessage } from "../domain/AntiCounter";
import {
  EntityPatchPayload,
  entityState,
  type EntityPatchPayload as EntityPatch,
} from "../contract/payload/World";
import type { Store } from "../state/Store";
import { auraEvents, messageText, projectAuraEvents } from "./Auras";

const Animation = Schema.Struct({
  animStr: Schema.optionalKey(Schema.String),
  cInf: Schema.optionalKey(Schema.String),
  msg: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  tInf: Schema.optionalKey(Schema.String),
});
const CounterAction = Schema.Struct({
  actionResult: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        cInf: Schema.optionalKey(Schema.String),
        ct: Schema.optionalKey(WireNumber),
      }),
    ),
  ),
});
const CombatPayload = Schema.Struct({
  a: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  anims: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  m: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ),
  p: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ),
  sara: Schema.optionalKey(Schema.Unknown),
});
const decodeCombat = Schema.decodeUnknownOption(CombatPayload);
const decodeAnimation = Schema.decodeUnknownOption(Animation);
const decodeCounterAction = Schema.decodeUnknownOption(CounterAction);
const decodeEntityPatch = Schema.decodeUnknownOption(EntityPatchPayload);

const entityPatch = (patch: EntityPatch) => {
  const state = entityState(patch.intState);
  return {
    ...(patch.intHP === undefined ? {} : { hp: patch.intHP }),
    ...(patch.intHPMax === undefined ? {} : { maxHp: patch.intHPMax }),
    ...(patch.intMP === undefined ? {} : { mp: patch.intMP }),
    ...(patch.intMPMax === undefined ? {} : { maxMp: patch.intMPMax }),
    ...(patch.strFrame === undefined ? {} : { cell: patch.strFrame }),
    ...(state === undefined ? {} : { state }),
  };
};

const antiCounterCastDurationMs = (
  value: unknown,
  monsterMapId: number,
): number | undefined => {
  if (!Array.isArray(value)) return undefined;
  let durationMs: number | undefined;
  for (const entry of value) {
    const decoded = decodeCounterAction(entry);
    if (Option.isNone(decoded)) continue;
    const result = decoded.value.actionResult;
    if (result === null || result === undefined) continue;
    if (
      !parseCombatEntityReferences(result.cInf ?? "").some(
        (entity) => entity.type === "monster" && entity.id === monsterMapId,
      )
    ) {
      continue;
    }
    if (result.ct === undefined || result.ct <= 0) continue;
    durationMs = Math.max(durationMs ?? 0, result.ct);
  }
  return durationMs;
};

export const projectCombat = (
  store: Store,
  packet: ExtensionPacket | ServerPacket,
  diagnose: DiagnosticReporter = ignoreDiagnostic,
): Effect.Effect<readonly Event[]> =>
  Effect.gen(function* () {
    if (packet.command !== "ct" && packet.command !== "cb") return [];
    const decoded = decodeCombat(packet.data);
    if (Option.isNone(decoded)) {
      yield* diagnose(
        `combat:${packet.command}`,
        new Error("Malformed combat payload"),
        [packet.data],
      );
      return [];
    }
    const events: Event[] = [];

    for (const [username, value] of Object.entries(decoded.value.p ?? {})) {
      const patch = decodeEntityPatch(value);
      if (Option.isNone(patch)) {
        yield* diagnose(
          "combat:malformed-player-update",
          new Error("Ignored malformed player combat update"),
          [username, value],
        );
        continue;
      }
      const current = yield* store.world.getPlayer(username);
      if (current === null) {
        yield* diagnose(
          "combat:unknown-player-update",
          new Error("Ignored update for unknown player"),
          [username, packet.data],
        );
        continue;
      }
      const result = yield* store.world.patchPlayer(username, {
        ...entityPatch(patch.value),
        ...(patch.value.afk === undefined ? {} : { afk: patch.value.afk }),
        ...(patch.value.intLevel === undefined
          ? {}
          : { level: patch.value.intLevel }),
        ...(patch.value.strPad === undefined
          ? {}
          : { pad: patch.value.strPad }),
        ...(patch.value.tx === undefined && patch.value.ty === undefined
          ? {}
          : {
              position: {
                x: patch.value.tx ?? current.position.x,
                y: patch.value.ty ?? current.position.y,
              },
            }),
      });
      if (result?.becameDead) {
        events.push({
          type: "player-death",
          entityId: result.player.entityId,
          username: result.player.username,
        });
      }
    }

    for (const [rawId, value] of Object.entries(decoded.value.m ?? {})) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const patch = decodeEntityPatch(value);
      if (Option.isNone(patch)) {
        yield* diagnose(
          "combat:malformed-monster-update",
          new Error("Ignored malformed monster combat update"),
          [rawId, value],
        );
        continue;
      }
      const result = yield* store.world.writeMonster(
        id,
        entityPatch(patch.value),
      );
      if (result === null) {
        yield* diagnose(
          "combat:unknown-monster-update",
          new Error("Ignored update for unknown monster"),
          [id, packet.data],
        );
        continue;
      }
      if (result?.becameDead) {
        events.push({ type: "monster-death", monsterMapId: id });
      }
      events.push(...auraEvents({ type: "monster", id }, result.auraChanges));
    }

    for (const value of decoded.value.anims ?? []) {
      const animation = decodeAnimation(value);
      if (Option.isNone(animation)) continue;
      const message = messageText(animation.value.msg);
      if (message === undefined) continue;
      const source =
        animation.value.cInf === undefined
          ? []
          : parseCombatEntityReferences(animation.value.cInf);
      const target =
        animation.value.tInf === undefined
          ? []
          : parseCombatEntityReferences(animation.value.tInf);
      const monsterMapId = [...source, ...target].find(
        (entity) => entity.type === "monster",
      )?.id;
      const monster =
        monsterMapId === undefined
          ? null
          : yield* store.world.getMonster(monsterMapId);
      const normalizedMessage =
        monster === null ? message : message.replaceAll("<mon>", monster.name);
      const antiCounterMatch = matchAntiCounterMessage(normalizedMessage);
      if (monsterMapId !== undefined && antiCounterMatch !== undefined) {
        const durationMs = antiCounterCastDurationMs(
          decoded.value.sara,
          monsterMapId,
        );
        events.push({
          type: "counter-attack-start",
          monsterMapId,
          source: "message",
          triggerId: antiCounterMatch.triggerId,
          triggerText: antiCounterMatch.triggerText,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      }
      events.push({
        type: "update-message",
        ...(animation.value.animStr === undefined
          ? {}
          : { animation: animation.value.animStr }),
        message: normalizedMessage,
        ...(monsterMapId === undefined ? {} : { monsterMapId }),
        source: "animation",
      });
    }

    if (decoded.value.a != null && decoded.value.a.length > 0) {
      const nowMs = yield* Clock.currentTimeMillis;
      events.push(
        ...(yield* projectAuraEvents(
          store,
          decoded.value.a,
          "merge",
          nowMs,
          diagnose,
        )),
      );
    }

    return events;
  });
