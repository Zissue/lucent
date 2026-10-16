import * as Effect from "effect/Effect";

import { DesktopIpc } from "./DesktopIpc";
import * as AboutIpcMethods from "./methods/about";
import * as AccountsIpcMethods from "./methods/accounts";
import * as AccountSettingsIpcMethods from "./methods/accountSettings";
import * as ArmyIpcMethods from "./methods/army";
import * as CombatProfilesIpcMethods from "./methods/combatProfiles";
import * as EnvironmentIpcMethods from "./methods/environment";
import * as FollowerIpcMethods from "./methods/follower";
import * as FileSystemIpcMethods from "./methods/filesystem";
import * as HttpIpcMethods from "./methods/http";
import * as GameRendererIpcMethods from "./methods/gameRenderer";
import * as GameViewsIpcMethods from "./methods/gameViews";
import * as LoaderGrabberIpcMethods from "./methods/loaderGrabber";
import * as PacketsIpcMethods from "./methods/packets";
import * as ScriptingIpcMethods from "./methods/scripting";
import * as SettingsIpcMethods from "./methods/settings";
import * as UpdatesIpcMethods from "./methods/updates";
import * as WindowsIpcMethods from "./methods/windows";

export const installDesktopIpcHandlers = Effect.fn(
  "desktop.ipc.installHandlers",
)(function* () {
  const ipc = yield* DesktopIpc;

  yield* AccountsIpcMethods.installEventForwarding();
  yield* ArmyIpcMethods.installLifecycle();
  yield* CombatProfilesIpcMethods.installEventForwarding();
  yield* SettingsIpcMethods.installEventForwarding();
  yield* ScriptingIpcMethods.installEventForwarding();
  yield* UpdatesIpcMethods.installEventForwarding();

  for (const method of desktopIpcMethods) {
    yield* ipc.handle<
      Effect.Error<ReturnType<typeof method.invoke>>,
      Effect.Services<ReturnType<typeof method.invoke>>
    >(method);
  }
});

export const desktopIpcMethods = [
  ...WindowsIpcMethods.methods,
  ...AboutIpcMethods.methods,
  ...AccountsIpcMethods.methods,
  ...AccountSettingsIpcMethods.methods,
  ...ArmyIpcMethods.methods,
  ...CombatProfilesIpcMethods.methods,
  ...EnvironmentIpcMethods.methods,
  ...FollowerIpcMethods.methods,
  ...FileSystemIpcMethods.methods,
  ...HttpIpcMethods.methods,
  ...GameRendererIpcMethods.methods,
  ...GameViewsIpcMethods.methods,
  ...LoaderGrabberIpcMethods.methods,
  ...PacketsIpcMethods.methods,
  ...SettingsIpcMethods.methods,
  ...ScriptingIpcMethods.methods,
  ...UpdatesIpcMethods.methods,
] as const;
