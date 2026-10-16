import * as Schema from "effect/Schema";

import { defineInvoke } from "./core";

const namespace = "desktop:about";

export const AboutFolderSchema = Schema.Literals([
  "appData",
  "logs",
  "scripts",
]);

export type AboutFolder = typeof AboutFolderSchema.Type;

export const AboutLinkSchema = Schema.Literals([
  "commit",
  "documentation",
  "issues",
  "releaseNotes",
  "repository",
]);

export type AboutLink = typeof AboutLinkSchema.Type;

export const AboutInfoSchema = Schema.Struct({
  build: Schema.Struct({
    builtAt: Schema.NullOr(Schema.String),
    commit: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
  }),
  channel: Schema.Literals(["development", "release"]),
  paths: Schema.Struct({
    appData: Schema.String,
    logs: Schema.String,
    scripts: Schema.String,
  }),
  system: Schema.Struct({
    arch: Schema.String,
    osVersion: Schema.String,
    platform: Schema.String,
  }),
  version: Schema.String,
});

export type AboutInfo = typeof AboutInfoSchema.Type;

export const AboutIpc = {
  getInfo: defineInvoke({
    channel: `${namespace}:get-info`,
    name: "about.getInfo",
    payload: Schema.Void,
    result: AboutInfoSchema,
  }),
  openFolder: defineInvoke({
    channel: `${namespace}:open-folder`,
    name: "about.openFolder",
    payload: Schema.Struct({ folder: AboutFolderSchema }),
    result: Schema.Boolean,
  }),
  openLink: defineInvoke({
    channel: `${namespace}:open-link`,
    name: "about.openLink",
    payload: Schema.Struct({ link: AboutLinkSchema }),
    result: Schema.Boolean,
  }),
} as const;
