import * as Schema from "effect/Schema";

import {
  AppearancePatchSchema,
  AppSettingsSchema,
  PreferencesPatchSchema,
} from "@lucent/core/settings";
import { HotkeysPatchSchema } from "@lucent/core/hotkeys";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:settings";

export const SettingsIpc = {
  get: defineInvoke({
    channel: `${namespace}:get`,
    payload: Schema.Void,
    result: AppSettingsSchema,
  }),
  updatePreferences: defineInvoke({
    channel: `${namespace}:update-preferences`,
    payload: PreferencesPatchSchema,
    result: AppSettingsSchema,
  }),
  updateAppearance: defineInvoke({
    channel: `${namespace}:update-appearance`,
    payload: AppearancePatchSchema,
    result: AppSettingsSchema,
  }),
  resetAppearance: defineInvoke({
    channel: `${namespace}:reset-appearance`,
    payload: Schema.Void,
    result: AppSettingsSchema,
  }),
  updateHotkeys: defineInvoke({
    channel: `${namespace}:update-hotkeys`,
    payload: HotkeysPatchSchema,
    result: AppSettingsSchema,
  }),
  resetHotkeys: defineInvoke({
    channel: `${namespace}:reset-hotkeys`,
    payload: Schema.Void,
    result: AppSettingsSchema,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: AppSettingsSchema,
  }),
} as const;
