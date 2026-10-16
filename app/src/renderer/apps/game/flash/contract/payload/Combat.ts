import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { NonNegativeWireInt, WireInt } from "../Coercion";

export interface CombatEntityReference {
  readonly id: number;
  readonly type: "monster" | "player";
}

export interface CombatActionAcknowledgement {
  readonly actionId: number;
  readonly outcome: 0 | 1;
  readonly source: CombatEntityReference;
  readonly targets: readonly CombatEntityReference[];
}

const ActionDetailsPayload = Schema.Struct({
  actID: Schema.optionalKey(NonNegativeWireInt),
  cInf: Schema.optionalKey(Schema.String),
  tInf: Schema.optionalKey(Schema.String),
});
const SingleActionAcknowledgementPayload = Schema.Struct({
  actionResult: Schema.optionalKey(Schema.NullOr(ActionDetailsPayload)),
  actID: Schema.optionalKey(NonNegativeWireInt),
  iRes: WireInt,
});
const AppliedActionPayload = Schema.Struct({
  tInf: Schema.String,
});
const MultiActionAcknowledgementPayload = Schema.Struct({
  a: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  actID: NonNegativeWireInt,
  cInf: Schema.String,
  iRes: WireInt,
});
const CombatActionAcknowledgementsPayload = Schema.Struct({
  sara: Schema.optionalKey(Schema.Unknown),
  sarsa: Schema.optionalKey(Schema.Unknown),
});
const decodeActionAcknowledgementsPayload = Schema.decodeUnknownOption(
  CombatActionAcknowledgementsPayload,
);
const decodeSingleActionAcknowledgement = Schema.decodeUnknownOption(
  SingleActionAcknowledgementPayload,
);
const decodeMultiActionAcknowledgement = Schema.decodeUnknownOption(
  MultiActionAcknowledgementPayload,
);
const decodeAppliedAction = Schema.decodeUnknownOption(AppliedActionPayload);

export const parseCombatEntityReferences = (
  value: string,
): readonly CombatEntityReference[] =>
  value.split(",").flatMap((token) => {
    const entity = token.slice(token.lastIndexOf(">") + 1).trim();
    const [type, rawId] = entity.split(":");
    const id = Number(rawId);
    if ((type !== "m" && type !== "p") || !Number.isInteger(id) || id <= 0) {
      return [];
    }
    return [
      {
        id,
        type: type === "m" ? ("monster" as const) : ("player" as const),
      },
    ];
  });

const outcome = (value: number): 0 | 1 | undefined =>
  value === 0 || value === 1 ? value : undefined;

const singleActionAcknowledgement = (
  value: unknown,
): CombatActionAcknowledgement | undefined => {
  const decoded = decodeSingleActionAcknowledgement(value);
  if (Option.isNone(decoded)) return undefined;

  const result = decoded.value.actionResult;
  const acknowledgedOutcome = outcome(decoded.value.iRes);
  if (result == null || acknowledgedOutcome === undefined) return undefined;

  // Rejections omit target data and leave the authoritative action ID on the
  // outer sara record.
  const actionId =
    acknowledgedOutcome === 1 ? result.actID : decoded.value.actID;
  const source = parseCombatEntityReferences(result.cInf ?? "")[0];
  if (actionId === undefined || source === undefined) return undefined;

  return {
    actionId,
    outcome: acknowledgedOutcome,
    source,
    targets:
      acknowledgedOutcome === 1 && result.tInf !== undefined
        ? parseCombatEntityReferences(result.tInf)
        : [],
  };
};

const multiActionAcknowledgement = (
  value: unknown,
): CombatActionAcknowledgement | undefined => {
  const decoded = decodeMultiActionAcknowledgement(value);
  if (Option.isNone(decoded)) return undefined;

  const acknowledgedOutcome = outcome(decoded.value.iRes);
  const source = parseCombatEntityReferences(decoded.value.cInf)[0];
  if (acknowledgedOutcome === undefined || source === undefined) {
    return undefined;
  }

  return {
    actionId: decoded.value.actID,
    outcome: acknowledgedOutcome,
    source,
    targets:
      acknowledgedOutcome === 0
        ? []
        : (decoded.value.a ?? []).flatMap((value) => {
            const applied = decodeAppliedAction(value);
            return Option.isNone(applied)
              ? []
              : parseCombatEntityReferences(applied.value.tInf);
          }),
  };
};

export const decodeCombatActionAcknowledgements = (
  value: unknown,
): readonly CombatActionAcknowledgement[] => {
  const decoded = decodeActionAcknowledgementsPayload(value);
  if (Option.isNone(decoded)) return [];

  const acknowledgements: CombatActionAcknowledgement[] = [];
  const append = (
    values: unknown,
    decode: (value: unknown) => CombatActionAcknowledgement | undefined,
  ): void => {
    if (!Array.isArray(values)) return;
    for (const entry of values) {
      const acknowledgement = decode(entry);
      if (acknowledgement !== undefined) acknowledgements.push(acknowledgement);
    }
  };

  append(decoded.value.sara, singleActionAcknowledgement);
  append(decoded.value.sarsa, multiActionAcknowledgement);
  return acknowledgements;
};
