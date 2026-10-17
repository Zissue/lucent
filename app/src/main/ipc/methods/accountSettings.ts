import * as Effect from "effect/Effect";

import { AccountSettingsIpc } from "../../../shared/ipc";
import { AccountSettingsRepository } from "../../game/account-settings/AccountSettingsRepository";
import { makeDesktopIpcMethod } from "../DesktopIpc";

const gameSenders = ["game"] as const;

export const get = makeDesktopIpcMethod({
  descriptor: AccountSettingsIpc.get,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.accountSettings.get")(function* (payload) {
    const repository = yield* AccountSettingsRepository;
    return yield* repository.get(payload.username);
  }),
});

export const update = makeDesktopIpcMethod({
  descriptor: AccountSettingsIpc.update,
  allowedSenders: gameSenders,
  handler: Effect.fn("desktop.ipc.accountSettings.update")(function* (payload) {
    const repository = yield* AccountSettingsRepository;
    return yield* repository.update(payload.username, payload.patch);
  }),
});

export const methods = [get, update] as const;
