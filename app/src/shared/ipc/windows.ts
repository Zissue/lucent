import * as Schema from "effect/Schema";

import { defineInvoke } from "./core";

const namespace = "desktop:windows";

export const DesktopWindowKindSchema = Schema.Literals([
  "about",
  "account-manager",
  "combat-profiles",
  "environment",
  "follower",
  "game",
  "loader-grabber",
  "packets",
  "settings",
]);

export const DesktopRendererKindSchema = Schema.Literals([
  ...DesktopWindowKindSchema.literals,
  "game-group-controls",
  "game-host",
]);

export const WindowsIpc = {
  open: defineInvoke({
    channel: `${namespace}:open`,
    name: "windows.open",
    payload: Schema.Struct({
      kind: DesktopWindowKindSchema,
    }),
    result: Schema.String,
  }),
} as const;
