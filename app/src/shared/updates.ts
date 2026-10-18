import * as Schema from "effect/Schema";

export class UpdateReleaseInfo extends Schema.Class<UpdateReleaseInfo>(
  "UpdateReleaseInfo",
)({
  version: Schema.String,
  tagName: Schema.String,
  htmlUrl: Schema.String,
  name: Schema.optionalKey(Schema.String),
  publishedAt: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
}) {}

export const UpdateCheckStateSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("idle"),
    currentVersion: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("disabled"),
    currentVersion: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("checking"),
    currentVersion: Schema.String,
    startedAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("current"),
    currentVersion: Schema.String,
    latestVersion: Schema.String,
    checkedAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("available"),
    currentVersion: Schema.String,
    latestVersion: Schema.String,
    checkedAt: Schema.String,
    release: UpdateReleaseInfo,
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    currentVersion: Schema.String,
    checkedAt: Schema.String,
    message: Schema.String,
  }),
]);

export type UpdateCheckState = typeof UpdateCheckStateSchema.Type;
