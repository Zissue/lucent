import * as Schema from "effect/Schema";

import {
  CombatProfileLibrarySchema,
  CombatProfileSchema,
} from "@lucent/core/combatProfiles";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:combat-profiles";

export const CombatProfilesIpc = {
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    payload: Schema.Void,
    result: CombatProfileLibrarySchema,
  }),
  saveProfile: defineInvoke({
    channel: `${namespace}:save-profile`,
    payload: CombatProfileSchema,
    result: CombatProfileLibrarySchema,
  }),
  deleteProfile: defineInvoke({
    channel: `${namespace}:delete-profile`,
    payload: Schema.Struct({
      profileId: Schema.String,
    }),
    result: CombatProfileLibrarySchema,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: CombatProfileLibrarySchema,
  }),
} as const;
