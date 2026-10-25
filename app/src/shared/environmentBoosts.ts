import { PositiveInt } from "@lucent/core";
import * as Schema from "effect/Schema";

export const EnvironmentBankBoostSchema = Schema.Struct({
  itemId: PositiveInt,
  name: Schema.String,
  quantity: PositiveInt,
});
export type EnvironmentBankBoost = typeof EnvironmentBankBoostSchema.Type;

export const EnvironmentBoostDiscoverySchema = Schema.Struct({
  bank: Schema.Array(EnvironmentBankBoostSchema),
  bankLoaded: Schema.Boolean,
  inventory: Schema.Array(Schema.String),
});
export type EnvironmentBoostDiscovery =
  typeof EnvironmentBoostDiscoverySchema.Type;
