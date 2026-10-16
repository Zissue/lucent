import type { ItemSnapshot } from "@lucent/game";

export type RuntimeEvent =
  | {
      /** The connection status changes. */
      readonly type: "connection";
      /** The connection status, such as `OnConnection` or `OnConnectionLost`. */
      readonly status: string;
    }
  | {
      /** A debug message is received. */
      readonly type: "debug";
      readonly message: string;
    };

export type ProjectionEvent =
  | {
      /** A game session starts. */
      readonly type: "login";
    }
  | {
      /** A game session ends. */
      readonly type: "logout";
    }
  | {
      /** A player goes AFK or comes back. */
      readonly type: "player-afk";
      readonly afk: boolean;
      readonly entityId: number;
      readonly username: string;
    }
  | {
      /** A map finishes loading. */
      readonly type: "join-map";
      readonly map: {
        readonly id: number;
        readonly name: string;
        readonly roomNumber: number;
      };
    }
  | {
      /** An item drops. */
      readonly type: "item-drop";
      readonly item: ItemSnapshot;
    }
  | {
      /** A quest turn-in succeeds. */
      readonly type: "quest-complete";
      readonly questId: number;
    }
  | {
      /** A monster dies. */
      readonly type: "monster-death";
      readonly monsterMapId: number;
    }
  | {
      /** A monster respawns. */
      readonly type: "monster-respawn";
      readonly monsterMapId: number;
    }
  | {
      /** A player dies. */
      readonly type: "player-death";
      readonly entityId: number;
      readonly username: string;
    }
  | {
      /** A player joins or leaves the current map. */
      readonly type: "players-changed";
    }
  | {
      /** An aura first appears on a player or monster. */
      readonly type: "aura-added";
      /** The aura duration in seconds, when available. */
      readonly duration?: number;
      readonly icon?: string;
      readonly kind: "active" | "passive";
      readonly name: string;
      readonly stack: number;
      /** The applying entity's map-scoped ID, when known. */
      readonly sourceId?: number;
      readonly sourceType?: "monster" | "player";
      /** The affected entity's map-scoped ID. */
      readonly targetId: number;
      readonly targetType: "monster" | "player";
    }
  | {
      /** An existing aura changes stack, timer, or metadata. */
      readonly type: "aura-updated";
      /** The aura duration in seconds, when available. */
      readonly duration?: number;
      readonly icon?: string;
      readonly kind: "active" | "passive";
      readonly name: string;
      readonly stack: number;
      /** The applying entity's map-scoped ID, when known. */
      readonly sourceId?: number;
      readonly sourceType?: "monster" | "player";
      /** The affected entity's map-scoped ID. */
      readonly targetId: number;
      readonly targetType: "monster" | "player";
    }
  | {
      /** An aura is removed from a player or monster. */
      readonly type: "aura-removed";
      /** The aura duration in seconds, when available. */
      readonly duration?: number;
      readonly icon?: string;
      readonly kind: "active" | "passive";
      readonly name: string;
      /** The applying entity's map-scoped ID, when known. */
      readonly sourceId?: number;
      readonly sourceType?: "monster" | "player";
      /** The affected entity's map-scoped ID. */
      readonly targetId: number;
      readonly targetType: "monster" | "player";
    }
  | {
      /** A monster's counter attack is applied, refreshed, or announced in a combat message. */
      readonly type: "counter-attack-start";
      /** The applied aura duration or announced window in milliseconds, when known. */
      readonly durationMs?: number;
      /** The monster's map-scoped ID. */
      readonly monsterMapId: number;
      /** Where the trigger was detected. */
      readonly source: "aura" | "message";
      /** A stable identifier for the recognized trigger. */
      readonly triggerId: string;
      /** The aura name or combat message that matched the trigger. */
      readonly triggerText: string;
    }
  | {
      /** A monster's active counter-attack aura is removed, including server state clears. */
      readonly type: "counter-attack-end";
      /** The monster's map-scoped ID. */
      readonly monsterMapId: number;
      /** Where the trigger was detected. */
      readonly source: "aura" | "message";
      /** A stable identifier for the recognized trigger. */
      readonly triggerId: string;
      /** The aura name or combat message that matched the trigger. */
      readonly triggerText: string;
    }
  | ({
      /** A player's location changes. */
      readonly type: "player-location";
      readonly cell: string;
      readonly entityId: number;
      readonly pad: string;
      /** The latest known coordinates for the player. */
      readonly position: {
        readonly x: number;
        readonly y: number;
      };
      readonly username: string;
    } & (
      | {
          /** The destination reported by a complete walk update. */
          readonly destination: {
            readonly x: number;
            readonly y: number;
          };
          readonly kind: "walk";
        }
      | {
          /** `position` reports coordinates; `cell` reports only cell/pad. */
          readonly kind: "cell" | "position";
        }
    ))
  | {
      /** A yellow combat message appears. */
      readonly type: "update-message";
      /** The animation's `animStr`, when present. */
      readonly animation?: string;
      readonly message: string;
      /** The related monster's map-scoped ID, when the message names one. */
      readonly monsterMapId?: number;
      readonly source: "animation" | "aura";
    }
  | {
      /** The current map's encounter zone changes. */
      readonly type: "zone";
      readonly map: string;
      readonly zone: string;
    };

export type Event = RuntimeEvent | ProjectionEvent;
export type EventType = Event["type"];

export type RuntimeEventSelector =
  | {
      readonly status?: string;
      readonly type: "connection";
    }
  | {
      readonly message?: string;
      readonly type: "debug";
    };

/**
 * An event-shaped partial selector. `type` chooses the event variant, and every
 * other field is an exact-match constraint on a scalar field of that variant.
 *
 * Omitting a field leaves it unconstrained. With exact optional property types,
 * explicitly passing `undefined` is invalid; untyped callers that do so safely
 * fail to match instead of selecting events where the field happens to be
 * absent.
 */
export type ProjectionEventSelector =
  | {
      readonly type: "login" | "logout";
    }
  | {
      readonly afk?: boolean;
      readonly entityId?: number;
      readonly type: "player-afk";
      readonly username?: string;
    }
  | {
      readonly type: "join-map";
    }
  | {
      readonly type: "item-drop";
    }
  | {
      readonly questId?: number;
      readonly type: "quest-complete";
    }
  | {
      readonly monsterMapId?: number;
      readonly type: "monster-death" | "monster-respawn";
    }
  | {
      readonly entityId?: number;
      readonly type: "player-death";
      readonly username?: string;
    }
  | {
      readonly entityId?: number;
      readonly kind?: "cell" | "position" | "walk";
      readonly type: "player-location";
      readonly username?: string;
    }
  | {
      readonly type: "players-changed";
    }
  | {
      readonly duration?: number;
      readonly icon?: string;
      readonly kind?: "active" | "passive";
      readonly name?: string;
      readonly sourceId?: number;
      readonly sourceType?: "monster" | "player";
      readonly targetId?: number;
      readonly targetType?: "monster" | "player";
      readonly type: "aura-added" | "aura-updated" | "aura-removed";
    }
  | {
      readonly durationMs?: number;
      readonly monsterMapId?: number;
      readonly source?: "aura" | "message";
      readonly triggerId?: string;
      readonly triggerText?: string;
      readonly type: "counter-attack-start";
    }
  | {
      readonly monsterMapId?: number;
      readonly source?: "aura" | "message";
      readonly triggerId?: string;
      readonly triggerText?: string;
      readonly type: "counter-attack-end";
    }
  | {
      readonly animation?: string;
      readonly message?: string;
      readonly monsterMapId?: number;
      readonly source?: "animation" | "aura";
      readonly type: "update-message";
    }
  | {
      readonly map?: string;
      readonly type: "zone";
      readonly zone?: string;
    };

export type EventSelector = RuntimeEventSelector | ProjectionEventSelector;

export type EventForSelector<S extends EventSelector | undefined> = S extends {
  readonly type: infer T extends EventType;
}
  ? EventForType<T>
  : Event;

export type EventForType<T extends EventType> = Extract<
  Event,
  { readonly type: T }
>;

export type EventSelectorForType<T extends EventType> = EventSelector & {
  readonly type: T;
};

export const isProjectionEvent = (event: Event): event is ProjectionEvent =>
  event.type !== "connection" && event.type !== "debug";

type Scalar = boolean | number | string;

const isScalar = (value: unknown): value is Scalar =>
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

export const matchesEvent = <S extends EventSelector | undefined>(
  event: Event,
  selector: S,
): event is EventForSelector<S> => {
  if (selector === undefined) return true;
  if (
    selector === null ||
    typeof selector !== "object" ||
    Array.isArray(selector)
  ) {
    return false;
  }

  const fields = Object.entries(selector);
  if (!fields.some(([key]) => key === "type")) return false;

  const record: Readonly<Record<string, unknown>> = event;
  return fields.every(
    ([key, value]) => isScalar(value) && record[key] === value,
  );
};
