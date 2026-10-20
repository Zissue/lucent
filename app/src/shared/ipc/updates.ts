import * as Schema from "effect/Schema";

import { UpdateCheckStateSchema } from "../updates";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:updates";

export const UpdatesIpc = {
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    payload: Schema.Void,
    result: UpdateCheckStateSchema,
  }),
  checkNow: defineInvoke({
    channel: `${namespace}:check-now`,
    payload: Schema.Void,
    result: UpdateCheckStateSchema,
  }),
  openReleasePage: defineInvoke({
    channel: `${namespace}:open-release-page`,
    payload: Schema.Void,
    result: Schema.Boolean,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: UpdateCheckStateSchema,
  }),
} as const;
