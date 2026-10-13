import * as Effect from "effect/Effect";

import { CombatProfilesIpc } from "../../../shared/ipc";
import { CombatProfiles } from "../../internal/combat-profiles/CombatProfiles";
import { DesktopIpc, makeDesktopIpcMethod } from "../DesktopIpc";

const combatProfileReaders = ["combat-profiles", "follower", "game"] as const;
const combatProfileWriters = ["combat-profiles", "game"] as const;

export const getState = makeDesktopIpcMethod({
  descriptor: CombatProfilesIpc.getState,
  allowedSenders: combatProfileReaders,
  handler: Effect.fn("desktop.ipc.combatProfiles.getState")(function* () {
    const combatProfiles = yield* CombatProfiles;
    return yield* combatProfiles.get;
  }),
});

export const saveProfile = makeDesktopIpcMethod({
  descriptor: CombatProfilesIpc.saveProfile,
  allowedSenders: combatProfileWriters,
  handler: Effect.fn("desktop.ipc.combatProfiles.saveProfile")(
    function* (profile) {
      const combatProfiles = yield* CombatProfiles;
      return yield* combatProfiles.saveProfile(profile);
    },
  ),
});

export const deleteProfile = makeDesktopIpcMethod({
  descriptor: CombatProfilesIpc.deleteProfile,
  allowedSenders: combatProfileWriters,
  handler: Effect.fn("desktop.ipc.combatProfiles.deleteProfile")(
    function* (payload) {
      const combatProfiles = yield* CombatProfiles;
      return yield* combatProfiles.deleteProfile(payload.profileId);
    },
  ),
});

export const methods = [getState, saveProfile, deleteProfile] as const;

export const installEventForwarding = Effect.fn(
  "desktop.ipc.combatProfiles.installEventForwarding",
)(function* () {
  const combatProfiles = yield* CombatProfiles;
  const ipc = yield* DesktopIpc;

  yield* Effect.acquireRelease(
    combatProfiles.onChanged((library) =>
      ipc.sendToAll(CombatProfilesIpc.changed, library),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
});
