import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EntityState } from "@lucent/game";

import type { BridgeService } from "../bridge/Bridge";
import { PositiveWireInt, UnknownRecord, WireInt } from "../contract/Coercion";
import type { Event } from "../contract/Event";
import {
  ignoreDiagnostic,
  type DiagnosticReporter,
} from "../contract/Diagnostic";
import type { ClientPacket, ExtensionPacket } from "../contract/Packet";
import {
  EntityPatchPayload,
  MonsterPayload,
  PlayerPayload,
  entityState,
  toMonster,
  toPlayer,
  type EntityPatchPayload as EntityPatch,
} from "../contract/payload/World";
import type { Store } from "../state/Store";
import { auraEvents, seedAuras } from "./Auras";

const MoveArea = Schema.Struct({
  areaId: Schema.optionalKey(PositiveWireInt),
  areaName: Schema.optionalKey(Schema.String),
  monBranch: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  mondef: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  monmap: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  uoBranch: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const PlayerUpdate = Schema.Struct({
  o: EntityPatchPayload,
  unm: Schema.String,
});
const MonsterUpdate = Schema.Struct({
  id: PositiveWireInt,
  o: EntityPatchPayload,
});
const Zone = Schema.Struct({
  args: Schema.Struct({ zoneSet: Schema.optionalKey(Schema.String) }),
});
const InitUser = Schema.Struct({
  data: UnknownRecord,
  uid: Schema.optionalKey(PositiveWireInt),
});
const PlayerBaselines = Schema.Struct({ a: Schema.Array(Schema.Unknown) });
const GoldExperience = Schema.Struct({
  id: PositiveWireInt,
  typ: Schema.String,
});
const ClassPointGain = Schema.Struct({ iCP: WireInt });
const NullablePlayerData = Schema.NullOr(UnknownRecord);
const decodeMoveArea = Schema.decodeUnknownOption(MoveArea);
const decodeRecord = Schema.decodeUnknownOption(UnknownRecord);
const decodePlayer = Schema.decodeUnknownOption(PlayerPayload);
const decodeMonster = Schema.decodeUnknownOption(MonsterPayload);
const decodePlayerUpdate = Schema.decodeUnknownOption(PlayerUpdate);
const decodeMonsterUpdate = Schema.decodeUnknownOption(MonsterUpdate);
const decodeZone = Schema.decodeUnknownOption(Zone);
const decodeInitUser = Schema.decodeUnknownOption(InitUser);
const decodePlayerBaselines = Schema.decodeUnknownOption(PlayerBaselines);
const decodeGoldExperience = Schema.decodeUnknownOption(GoldExperience);
const decodeClassPointGain = Schema.decodeUnknownOption(ClassPointGain);
const decodeInt = Schema.decodeUnknownOption(WireInt);
const decodePositiveInt = Schema.decodeUnknownOption(PositiveWireInt);
const decodeString = Schema.decodeUnknownOption(Schema.String);

const localUserId = (store: Store, bridge: BridgeService | undefined) =>
  store.world.getSelfEntityId.pipe(
    Effect.flatMap((cached) => {
      if (cached !== null) return Effect.succeed(Option.some(cached));
      return bridge === undefined
        ? Effect.succeed(Option.none<number>())
        : bridge.invoke("player.getUserId", undefined, PositiveWireInt);
    }),
  );

const getOrHydrateSelf = (
  store: Store,
  bridge: BridgeService | undefined,
  diagnose: DiagnosticReporter,
) =>
  Effect.gen(function* () {
    const projected = yield* store.world.getMe;
    if (projected !== null) return projected;
    if (bridge === undefined) return null;

    const userId = yield* localUserId(store, bridge);
    if (Option.isNone(userId)) return null;

    const existing = yield* store.world.getPlayer(userId.value);
    if (existing !== null) {
      yield* store.world.setSelf(existing.username);
      return existing;
    }

    const data = yield* bridge.invoke(
      "player.getData",
      undefined,
      NullablePlayerData,
    );
    if (Option.isNone(data) || data.value === null) return null;

    const decoded = decodePlayer({ ...data.value, entID: userId.value });
    if (Option.isNone(decoded)) {
      yield* diagnose(
        "world:self-hydration",
        new Error("Malformed local player bridge data"),
        [data.value, userId.value],
      );
      return null;
    }

    const player = yield* store.world.putPlayer(toPlayer(decoded.value));
    yield* store.world.setSelf(player.username);
    return player;
  });

const parseCsv = (value: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const token of value.split(",")) {
    const separator = token.indexOf(":");
    if (separator > 0) {
      result[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  return result;
};

const decodeInitializedPlayer = (value: unknown) =>
  Option.flatMap(decodeInitUser(value), (initialized) =>
    decodePlayer({
      ...initialized.data,
      entID: initialized.uid ?? initialized.data["entID"],
    }),
  );

const decodeStringMonsterUpdate = (packet: ExtensionPacket) => {
  const data = packet.data;
  if (!Array.isArray(data)) return Option.none<typeof MonsterUpdate.Type>();
  const patch = data[3];
  return typeof patch === "string"
    ? decodeMonsterUpdate({ id: data[2], o: parseCsv(patch) })
    : Option.none();
};

const decodeStringPlayerUpdate = (packet: ExtensionPacket) => {
  const data = packet.data;
  if (!Array.isArray(data)) return Option.none<typeof PlayerUpdate.Type>();
  const username = data[2];
  const patch = data[3];
  if (typeof username !== "string" || typeof patch !== "string") {
    return Option.none<typeof PlayerUpdate.Type>();
  }
  return decodePlayerUpdate({
    o: parseCsv(patch),
    unm: username,
  });
};

const parseMap = (area: string | undefined) => {
  const value = area?.trim() ?? "";
  const match = value.match(/^(.*?)(?:-(\d+))?$/);
  return {
    name: match?.[1] ?? value,
    roomNumber: match?.[2] === undefined ? 0 : Number(match[2]),
  };
};

const usernamesEqual = (left: string, right: string): boolean =>
  left.trim() !== "" &&
  right.trim() !== "" &&
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

const locationTextEqual = (left: string, right: string): boolean =>
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

const playerPatch = (
  patch: EntityPatch,
  currentPosition: { readonly x: number; readonly y: number },
) => {
  const position =
    patch.px === undefined &&
    patch.py === undefined &&
    patch.tx === undefined &&
    patch.ty === undefined
      ? undefined
      : {
          x: patch.px ?? patch.tx ?? currentPosition.x,
          y: patch.py ?? patch.ty ?? currentPosition.y,
        };

  return {
    ...(patch.afk === undefined ? {} : { afk: patch.afk }),
    ...(patch.entID === undefined ? {} : { entityId: patch.entID }),
    ...(patch.intHP === undefined ? {} : { hp: patch.intHP }),
    ...(patch.intHPMax === undefined ? {} : { maxHp: patch.intHPMax }),
    ...(patch.intLevel === undefined ? {} : { level: patch.intLevel }),
    ...(patch.intMP === undefined ? {} : { mp: patch.intMP }),
    ...(patch.intMPMax === undefined ? {} : { maxMp: patch.intMPMax }),
    ...(entityState(patch.intState) === undefined
      ? {}
      : { state: entityState(patch.intState)! }),
    ...(patch.strFrame === undefined ? {} : { cell: patch.strFrame }),
    ...(patch.strPad === undefined ? {} : { pad: patch.strPad }),
    ...(position === undefined ? {} : { position }),
  };
};

const playerMovementDestination = (patch: EntityPatch) =>
  patch.tx === undefined ||
  patch.ty === undefined ||
  (patch.tx === 0 && patch.ty === 0)
    ? undefined
    : { x: patch.tx, y: patch.ty };

const playerHasReportedPosition = (patch: EntityPatch): boolean =>
  patch.px !== undefined ||
  patch.py !== undefined ||
  (patch.tx !== undefined && patch.tx !== 0) ||
  (patch.ty !== undefined && patch.ty !== 0);

type PlayerLocationMovement =
  | { readonly kind: "cell" | "position" }
  | {
      readonly destination: { readonly x: number; readonly y: number };
      readonly kind: "walk";
    };

const playerLocationEvent = (
  player: ReturnType<typeof toPlayer>,
  movement: PlayerLocationMovement,
): Extract<Event, { readonly type: "player-location" }> => ({
  cell: player.cell,
  entityId: player.entityId,
  ...movement,
  pad: player.pad,
  position: { ...player.position },
  type: "player-location",
  username: player.username,
});

const monsterPatch = (patch: EntityPatch) => ({
  ...(patch.intHP === undefined ? {} : { hp: patch.intHP }),
  ...(patch.intHPMax === undefined ? {} : { maxHp: patch.intHPMax }),
  ...(patch.intMP === undefined ? {} : { mp: patch.intMP }),
  ...(patch.intMPMax === undefined ? {} : { maxMp: patch.intMPMax }),
  ...(entityState(patch.intState) === undefined
    ? {}
    : { state: entityState(patch.intState)! }),
  ...(patch.strFrame === undefined ? {} : { cell: patch.strFrame }),
});

const projectMoveArea = (
  store: Store,
  packet: ExtensionPacket,
  diagnose: DiagnosticReporter,
  bridge: BridgeService | undefined,
  nowMs: number,
) =>
  Effect.gen(function* () {
    const decoded = decodeMoveArea(packet.data);
    if (Option.isNone(decoded)) {
      yield* diagnose(
        "world:moveToArea",
        new Error("Malformed area baseline"),
        [packet.data],
      );
      yield* store.projection.fail("map", "moveToArea payload is malformed");
      return [];
    }
    const previousAuth = yield* store.auth.get;
    const previousSelf = yield* store.world.getMe;
    const mapName = parseMap(decoded.value.areaName);
    const map = {
      id: decoded.value.areaId ?? 0,
      ...mapName,
    };

    const invalidAuraEntries: unknown[] = [];
    const invalidMonsterEntries: unknown[] = [];
    const definitions = new Map<number, Record<string, unknown>>();
    for (const value of decoded.value.mondef ?? []) {
      const record = decodeRecord(value);
      if (Option.isNone(record)) {
        invalidMonsterEntries.push(value);
        continue;
      }
      const definition = record.value;
      const id = decodePositiveInt(definition["MonID"]);
      if (Option.isSome(id)) definitions.set(id.value, definition);
    }
    const cells = new Map<number, string>();
    for (const value of decoded.value.monmap ?? []) {
      const record = decodeRecord(value);
      if (Option.isNone(record)) {
        invalidMonsterEntries.push(value);
        continue;
      }
      const placement = record.value;
      const id = decodePositiveInt(placement["MonMapID"]);
      const cell = decodeString(placement["strFrame"]);
      if (Option.isSome(id) && Option.isSome(cell)) {
        cells.set(id.value, cell.value);
      }
    }
    const monsters: ReturnType<typeof toMonster>[] = [];
    for (const value of decoded.value.monBranch ?? []) {
      const record = decodeRecord(value);
      if (Option.isNone(record)) {
        invalidMonsterEntries.push(value);
        continue;
      }
      const branch = record.value;
      const monsterId = decodePositiveInt(branch["MonID"]);
      const monsterMapId = decodePositiveInt(branch["MonMapID"]);
      if (Option.isNone(monsterId) || Option.isNone(monsterMapId)) {
        invalidMonsterEntries.push(value);
        continue;
      }
      const decodedMonster = decodeMonster({
        ...definitions.get(monsterId.value),
        ...branch,
        ...(cells.get(monsterMapId.value) === undefined
          ? {}
          : { strFrame: cells.get(monsterMapId.value) }),
      });
      if (Option.isNone(decodedMonster)) {
        invalidMonsterEntries.push(value);
      } else {
        const monster = toMonster(decodedMonster.value);
        const seed = seedAuras(monster, decodedMonster.value.au, nowMs);
        invalidAuraEntries.push(...seed.rejected);
        monsters.push(monster);
      }
    }

    if (invalidMonsterEntries.length > 0) {
      yield* diagnose(
        "world:moveToArea:monster-entries",
        new Error(
          `Ignored ${invalidMonsterEntries.length} malformed monster entries`,
        ),
        invalidMonsterEntries,
      );
    }

    const invalidPlayerEntries: unknown[] = [];
    const players: ReturnType<typeof toPlayer>[] = [];
    for (const value of decoded.value.uoBranch ?? []) {
      const player = decodePlayer(value);
      if (Option.isNone(player)) {
        invalidPlayerEntries.push(value);
      } else {
        const entity = toPlayer(player.value);
        const seed = seedAuras(entity, player.value.au, nowMs);
        invalidAuraEntries.push(...seed.rejected);
        players.push(entity);
      }
    }

    if (invalidPlayerEntries.length > 0) {
      yield* diagnose(
        "world:moveToArea:player-entries",
        new Error(
          `Ignored ${invalidPlayerEntries.length} malformed player entries`,
        ),
        invalidPlayerEntries,
      );
    }

    if (invalidAuraEntries.length > 0) {
      yield* diagnose(
        "world:moveToArea:aura-entries",
        new Error(
          `Ignored ${invalidAuraEntries.length} malformed aura entries`,
        ),
        invalidAuraEntries,
      );
    }

    if (
      previousSelf !== null &&
      usernamesEqual(previousSelf.username, previousAuth.username) &&
      !players.some((player) =>
        usernamesEqual(player.username, previousSelf.username),
      )
    ) {
      players.push(previousSelf);
    }

    yield* store.world.clearArea;
    yield* store.world.setMap(map);
    yield* store.world.setMonsters(monsters);
    yield* store.world.setPlayers(players);
    let self = players.find((player) =>
      usernamesEqual(player.username, previousAuth.username),
    );
    if (self === undefined) {
      const userId = yield* localUserId(store, bridge);
      if (Option.isSome(userId)) {
        self = players.find((player) => player.entityId === userId.value);
      }
    }
    if (map.name === "") {
      yield* store.projection.fail(
        "map",
        "moveToArea omitted a usable areaName",
      );
    } else {
      yield* store.projection.complete("map");
    }
    if (self === undefined) {
      yield* store.projection.fail(
        "player",
        "moveToArea did not establish the local player",
      );
    } else {
      if (previousSelf !== null && self !== previousSelf) {
        self.projectAuras(
          {
            type: "passives",
            mode: "replace",
            entries: previousSelf.auras
              .filter((aura) => aura.kind === "passive")
              .map((aura) => aura.toJSON()),
          },
          nowMs,
        );
      }
      yield* store.world.setSelf(self.username);
      yield* store.projection.complete("player");
    }
    return [
      { type: "join-map", map },
      { type: "players-changed" },
    ] satisfies readonly Event[];
  });

export const projectClientWorld = Effect.fn("projectClientWorld")(function* (
  store: Store,
  packet: ClientPacket,
  diagnose: DiagnosticReporter = ignoreDiagnostic,
  bridge?: BridgeService,
): Effect.fn.Return<readonly Event[]> {
  switch (packet.command) {
    case "moveToCell": {
      const current = yield* getOrHydrateSelf(store, bridge, diagnose);
      if (current === null) {
        yield* diagnose(
          "world:client-movement-without-self",
          new Error("Cannot project cell movement without a local player"),
          [packet.params],
        );
        return [];
      }
      const cell = packet.params[4];
      const pad = packet.params[5];
      if (cell === undefined) return [];
      const result = yield* store.world.patchPlayer(current.username, {
        cell,
        ...(pad === undefined ? {} : { pad }),
      });
      return result === null
        ? []
        : [playerLocationEvent(result.player, { kind: "cell" })];
    }
    case "mv": {
      const current = yield* getOrHydrateSelf(store, bridge, diagnose);
      const x = decodeInt(packet.params[4]);
      const y = decodeInt(packet.params[5]);
      if (current === null) {
        yield* diagnose(
          "world:client-movement-without-self",
          new Error("Cannot project position movement without a local player"),
          [packet.params],
        );
        return [];
      }
      if (Option.isNone(x) || Option.isNone(y)) return [];
      const destination = { x: x.value, y: y.value };
      const result = yield* store.world.patchPlayer(current.username, {
        position: { x: x.value, y: y.value },
      });
      return result === null
        ? []
        : [
            playerLocationEvent(result.player, {
              destination,
              kind: "walk",
            }),
          ];
    }
    default:
      return [];
  }
});

export const projectExtensionWorld = (
  store: Store,
  packet: ExtensionPacket,
  diagnose: DiagnosticReporter = ignoreDiagnostic,
  bridge?: BridgeService,
): Effect.Effect<readonly Event[]> =>
  Effect.gen(function* () {
    switch (packet.command) {
      case "moveToArea": {
        const nowMs = yield* Clock.currentTimeMillis;
        return yield* projectMoveArea(store, packet, diagnose, bridge, nowMs);
      }
      case "initUserData":
      case "initUserDatas": {
        const data = packet.data;
        const baselines =
          packet.command === "initUserData"
            ? Option.some([data] as readonly unknown[])
            : Option.map(decodePlayerBaselines(data), (payload) => payload.a);
        if (Option.isNone(baselines)) {
          yield* diagnose(
            `world:${packet.command}`,
            new Error("Malformed player baseline"),
            [data],
          );
          yield* store.projection.fail(
            "player",
            `${packet.command} payload is malformed`,
          );
          return [];
        }

        const auth = yield* store.auth.get;
        const userId = yield* localUserId(store, bridge);
        let playersChanged = false;
        for (const baseline of baselines.value) {
          const decoded = decodeInitializedPlayer(baseline);
          if (Option.isNone(decoded)) {
            yield* diagnose(
              `world:${packet.command}`,
              new Error("Malformed player baseline entry"),
              [baseline],
            );
            continue;
          }
          // AQW keeps this avatar metadata separate from its authoritative
          // world-state leaf, so only use it when no world baseline exists.
          const fallback = toPlayer(decoded.value);
          let player = yield* store.world.getPlayer(fallback.entityId);
          if (player === null) {
            player = yield* store.world.getPlayer(fallback.username);
          }
          if (player === null) {
            player = yield* store.world.putPlayer(fallback);
            playersChanged = true;
          }
          if (
            (Option.isSome(userId) && player.entityId === userId.value) ||
            usernamesEqual(player.username, auth.username)
          ) {
            yield* store.world.setSelf(player.username);
          }
        }
        if ((yield* store.world.getMe) === null) {
          yield* store.projection.fail(
            "player",
            `${packet.command} did not establish the local player`,
          );
        } else {
          yield* store.projection.complete("player");
        }
        return playersChanged
          ? ([{ type: "players-changed" }] satisfies readonly Event[])
          : [];
      }
      case "exitArea": {
        const data = packet.data;
        const username = Array.isArray(data)
          ? decodeString(data[3])
          : Option.none();
        if (Option.isSome(username)) {
          const removed = yield* store.world.removePlayer(username.value);
          return removed === null
            ? []
            : ([{ type: "players-changed" }] satisfies readonly Event[]);
        }
        return [];
      }
      case "uotls": {
        const decoded =
          packet.encoding === "string"
            ? decodeStringPlayerUpdate(packet)
            : decodePlayerUpdate(packet.data);
        if (Option.isNone(decoded)) {
          yield* diagnose("world:uotls", new Error("Malformed player update"), [
            packet.data,
          ]);
          const record = decodeRecord(packet.data);
          const username =
            Option.isSome(record) && typeof record.value["unm"] === "string"
              ? record.value["unm"]
              : "";
          const auth = yield* store.auth.get;
          if (usernamesEqual(username, auth.username)) {
            yield* store.projection.fail(
              "player",
              "initial uotls player payload is malformed",
            );
          }
          return [];
        }
        const auth = yield* store.auth.get;
        let current = yield* store.world.getPlayer(decoded.value.unm);
        let playersChanged = false;
        if (current === null) {
          const baseline =
            packet.encoding === "json"
              ? Option.flatMap(decodeRecord(packet.data), (data) =>
                  Option.flatMap(decodeRecord(data["o"]), (player) =>
                    decodePlayer({
                      ...player,
                      uoName: decoded.value.unm,
                    }),
                  ),
                )
              : Option.none();
          if (Option.isNone(baseline)) {
            yield* diagnose(
              "world:unknown-player-update",
              new Error("Ignored update for unknown player"),
              [decoded.value.unm, packet.data],
            );
            if (usernamesEqual(decoded.value.unm, auth.username)) {
              yield* store.projection.fail(
                "player",
                "initial uotls omitted the local player baseline",
              );
            }
            return [];
          }
          current = yield* store.world.putPlayer(toPlayer(baseline.value));
          playersChanged = true;
        }
        const locationChanged =
          (decoded.value.o.strFrame !== undefined &&
            !locationTextEqual(current.cell, decoded.value.o.strFrame)) ||
          (decoded.value.o.strPad !== undefined &&
            !locationTextEqual(current.pad, decoded.value.o.strPad));
        const result = yield* store.world.patchPlayer(
          current.username,
          playerPatch(decoded.value.o, current.position),
        );
        if (result === null) return [];
        if (usernamesEqual(result.player.username, auth.username)) {
          yield* store.world.setSelf(result.player.username);
          yield* store.projection.complete("player");
        } else if ((yield* store.world.getMe) !== null) {
          yield* store.projection.complete("player");
        }
        const events: Event[] = playersChanged
          ? [{ type: "players-changed" }]
          : [];
        if (
          decoded.value.o.strFrame !== undefined ||
          decoded.value.o.strPad !== undefined ||
          decoded.value.o.px !== undefined ||
          decoded.value.o.py !== undefined ||
          decoded.value.o.tx !== undefined ||
          decoded.value.o.ty !== undefined
        ) {
          const destination = playerMovementDestination(decoded.value.o);
          events.push(
            playerLocationEvent(
              result.player,
              destination !== undefined
                ? { destination, kind: "walk" }
                : {
                    kind:
                      locationChanged ||
                      !playerHasReportedPosition(decoded.value.o)
                        ? "cell"
                        : "position",
                  },
            ),
          );
        }
        if (result.becameDead) {
          events.push({
            type: "player-death",
            entityId: result.player.entityId,
            username: result.player.username,
          });
        }
        if (decoded.value.o.afk !== undefined) {
          events.push({
            afk: decoded.value.o.afk,
            entityId: result.player.entityId,
            type: "player-afk",
            username: result.player.username,
          });
        }
        return events;
      }
      case "mtls": {
        const decoded =
          packet.encoding === "string"
            ? decodeStringMonsterUpdate(packet)
            : decodeMonsterUpdate(packet.data);
        if (Option.isNone(decoded)) {
          yield* diagnose("world:mtls", new Error("Malformed monster update"), [
            packet.data,
          ]);
          return [];
        }
        const result = yield* store.world.writeMonster(
          decoded.value.id,
          monsterPatch(decoded.value.o),
        );
        if (result === null) {
          yield* diagnose(
            "world:unknown-monster-update",
            new Error("Ignored update for unknown monster"),
            [decoded.value.id, packet.data],
          );
          return [];
        }
        const events: Event[] = result.becameDead
          ? [{ type: "monster-death", monsterMapId: decoded.value.id }]
          : [];
        events.push(
          ...auraEvents(
            { type: "monster", id: decoded.value.id },
            result.auraChanges,
          ),
        );
        return events;
      }
      case "mtcid": {
        yield* Effect.log("[world] mtcid packet received", { packet });
        if (bridge === undefined) return [];
        const loaded = yield* bridge.invoke(
          "world.isLoaded",
          undefined,
          Schema.Boolean,
        );
        if (Option.isNone(loaded) || !loaded.value) return [];

        const current = yield* getOrHydrateSelf(store, bridge, diagnose);
        if (current === null) {
          yield* diagnose(
            "world:client-movement-without-self",
            new Error("Cannot project cell transition without a local player"),
            [packet.data],
          );
          return [];
        }

        const [cell, pad] = yield* Effect.all([
          bridge.invoke("player.getCell", undefined, Schema.String),
          bridge.invoke("player.getPad", undefined, Schema.String),
        ]);
        if (
          Option.isNone(cell) ||
          Option.isNone(pad) ||
          cell.value === "" ||
          pad.value === ""
        )
          return [];

        const result = yield* store.world.patchPlayer(current.username, {
          cell: cell.value,
          pad: pad.value,
        });
        return result === null
          ? []
          : [playerLocationEvent(result.player, { kind: "cell" })];
      }
      case "clearAuras": {
        const current = yield* store.world.getMe;
        if (current === null) return [];
        const target = { type: "player", id: current.entityId } as const;
        const nowMs = yield* Clock.currentTimeMillis;
        const changes = yield* store.world.projectAuras(
          target,
          { type: "clear", keepPersistent: true },
          nowMs,
        );
        return auraEvents(target, changes);
      }
      case "event": {
        const decoded = decodeZone(packet.data);
        if (Option.isNone(decoded)) return [];
        const map = yield* store.world.getMap;
        return [
          {
            type: "zone",
            map: map.name,
            zone: decoded.value.args.zoneSet ?? "",
          },
        ];
      }
      case "respawnMon": {
        const data = packet.data;
        const ids =
          Array.isArray(data) && typeof data[2] === "string"
            ? data[2].split(",").flatMap((value) => {
                const id = decodePositiveInt(value);
                return Option.isSome(id) ? [id.value] : [];
              })
            : [];
        const events: Event[] = [];
        for (const id of ids) {
          const monster = yield* store.world.getMonster(id);
          if (monster === null) {
            yield* diagnose(
              "world:unknown-monster-respawn",
              new Error("Ignored respawn for unknown monster"),
              [id],
            );
            continue;
          }
          yield* store.world.patchMonster(id, {
            hp: monster.maxHp,
            mp: monster.maxMp,
            state: EntityState.Idle,
          });
          events.push({ type: "monster-respawn", monsterMapId: id });
        }
        return events;
      }
      case "addGoldExp": {
        const classPointGain = decodeClassPointGain(packet.data);
        if (Option.isSome(classPointGain)) {
          // AQW's iCP total already includes the optional bonusCP portion.
          const equippedClass = (yield* store.items.getAll("inventory")).find(
            (item) => item.classItem && item.equipped,
          );
          if (equippedClass !== undefined) {
            equippedClass.update({
              quantity: Math.max(
                0,
                equippedClass.quantity + classPointGain.value.iCP,
              ),
            });
          }
        }

        const decoded = decodeGoldExperience(packet.data);
        if (Option.isNone(decoded) || decoded.value.typ !== "m") return [];
        const result = yield* store.world.patchMonster(decoded.value.id, {
          hp: 0,
          mp: 0,
          state: EntityState.Dead,
        });
        return result?.becameDead
          ? [{ type: "monster-death", monsterMapId: decoded.value.id }]
          : [];
      }
      default:
        return [];
    }
  });
