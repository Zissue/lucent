import * as Schema from "effect/Schema";

import { UpdateCheckStateSchema } from "../updates";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:updates";

export const UpdatesIpc = {
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    name: "updates.getState",
    payload: Schema.Void,
    result: UpdateCheckStateSchema,
  }),
  checkNow: defineInvoke({
    channel: `${namespace}:check-now`,
    name: "updates.checkNow",
    payload: Schema.Void,
    result: UpdateCheckStateSchema,
  }),
  openReleasePage: defineInvoke({
    channel: `${namespace}:open-release-page`,
    name: "updates.openReleasePage",
    payload: Schema.Void,
    result: Schema.Boolean,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    name: "updates.changed",
    payload: UpdateCheckStateSchema,
  }),
} as const;
