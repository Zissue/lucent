import * as Effect from "effect/Effect";

import { SettingsIpc } from "../../../shared/ipc";
import { DesktopSettings } from "../../settings/DesktopSettings";
import {
  ALL_DESKTOP_RENDERER_KINDS,
  DesktopIpc,
  makeDesktopIpcMethod,
} from "../DesktopIpc";

const settingsSenders = ["settings"] as const;

export const get = makeDesktopIpcMethod({
  descriptor: SettingsIpc.get,
  allowedSenders: ALL_DESKTOP_RENDERER_KINDS,
  handler: Effect.fn("desktop.ipc.settings.get")(function* () {
    const settings = yield* DesktopSettings;
    return yield* settings.get;
  }),
});

export const updatePreferences = makeDesktopIpcMethod({
  descriptor: SettingsIpc.updatePreferences,
  allowedSenders: settingsSenders,
  handler: Effect.fn("desktop.ipc.settings.updatePreferences")(
    function* (patch) {
      const settings = yield* DesktopSettings;
      return yield* settings.updatePreferences(patch);
    },
  ),
});

export const updateAppearance = makeDesktopIpcMethod({
  descriptor: SettingsIpc.updateAppearance,
  allowedSenders: settingsSenders,
  handler: Effect.fn("desktop.ipc.settings.updateAppearance")(
    function* (patch) {
      const settings = yield* DesktopSettings;
      return yield* settings.updateAppearance(patch);
    },
  ),
});

export const resetAppearance = makeDesktopIpcMethod({
  descriptor: SettingsIpc.resetAppearance,
  allowedSenders: settingsSenders,
  handler: Effect.fn("desktop.ipc.settings.resetAppearance")(function* () {
    const settings = yield* DesktopSettings;
    return yield* settings.resetAppearance;
  }),
});

export const updateHotkeys = makeDesktopIpcMethod({
  descriptor: SettingsIpc.updateHotkeys,
  allowedSenders: settingsSenders,
  handler: Effect.fn("desktop.ipc.settings.updateHotkeys")(function* (patch) {
    const settings = yield* DesktopSettings;
    return yield* settings.updateHotkeys(patch);
  }),
});

export const resetHotkeys = makeDesktopIpcMethod({
  descriptor: SettingsIpc.resetHotkeys,
  allowedSenders: settingsSenders,
  handler: Effect.fn("desktop.ipc.settings.resetHotkeys")(function* () {
    const settings = yield* DesktopSettings;
    return yield* settings.resetHotkeys;
  }),
});

export const methods = [
  get,
  updatePreferences,
  updateAppearance,
  resetAppearance,
  updateHotkeys,
  resetHotkeys,
] as const;

export const installEventForwarding = Effect.fn(
  "desktop.ipc.settings.installEventForwarding",
)(function* () {
  const ipc = yield* DesktopIpc;
  const settings = yield* DesktopSettings;

  yield* settings.onChanged((nextSettings) =>
    ipc.sendToAll(SettingsIpc.changed, nextSettings),
  );
});
