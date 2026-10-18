import * as Schema from "effect/Schema";

import {
  AccountSettingsPatchSchema,
  AccountSettingsSchema,
} from "@lucent/core/accountSettings";
import { defineInvoke } from "./core";

const namespace = "desktop:account-settings";

const UsernamePayloadSchema = Schema.Struct({
  username: Schema.String,
});

export const AccountSettingsIpc = {
  get: defineInvoke({
    channel: `${namespace}:get`,
    payload: UsernamePayloadSchema,
    result: AccountSettingsSchema,
  }),
  update: defineInvoke({
    channel: `${namespace}:update`,
    payload: Schema.Struct({
      username: Schema.String,
      patch: AccountSettingsPatchSchema,
    }),
    result: AccountSettingsSchema,
  }),
} as const;
