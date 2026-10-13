import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

const invalid = (value: unknown, message: string) =>
  Effect.fail(
    new SchemaIssue.InvalidValue({ message }, value, { reportInput: true }),
  );

const NumberInput = Schema.Union([Schema.Number, Schema.String]);

export const WireNumber = NumberInput.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        if (typeof value === "number") {
          return Number.isFinite(value)
            ? Effect.succeed(value)
            : invalid(value, "Expected a finite number");
        }

        const trimmed = value.trim();
        if (trimmed === "") {
          return invalid(value, "Expected a numeric string");
        }

        const decoded = Number(trimmed);
        return Number.isFinite(decoded)
          ? Effect.succeed(decoded)
          : invalid(value, "Expected a numeric string");
      },
      encode: Effect.succeed,
    }),
  ),
);

export const WireInt = WireNumber.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(Math.trunc(value)),
      encode: Effect.succeed,
    }),
  ),
);

export const PositiveWireInt = WireInt.check(Schema.isGreaterThanOrEqualTo(1));
export const NonNegativeWireInt = WireInt.check(
  Schema.isGreaterThanOrEqualTo(0),
);

const BooleanInput = Schema.Union([
  Schema.Boolean,
  Schema.Number,
  Schema.String,
]);

export const WireBoolean = BooleanInput.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        if (typeof value === "boolean") return Effect.succeed(value);
        if (value === 1 || value === "1" || value === "true") {
          return Effect.succeed(true);
        }
        if (value === 0 || value === "0" || value === "false") {
          return Effect.succeed(false);
        }
        return invalid(value, "Expected a boolean or boolean wire value");
      },
      encode: Effect.succeed,
    }),
  ),
);

export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export const UnknownArray = Schema.Array(Schema.Unknown);
