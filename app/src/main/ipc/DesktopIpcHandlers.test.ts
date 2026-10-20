import { describe, expect, it } from "@effect/vitest";

import {
  AboutIpc,
  AccountsIpc,
  AccountSettingsIpc,
  ArmyIpc,
  CombatProfilesIpc,
  EnvironmentIpc,
  FileSystemIpc,
  HttpIpc,
  FollowerIpc,
  GameViewsIpc,
  GameRendererIpc,
  LoaderGrabberIpc,
  PacketsIpc,
  ScriptingIpc,
  SettingsIpc,
  UpdatesIpc,
  WindowsIpc,
  type IpcInvokeDescriptor,
} from "../../shared/ipc";
import { desktopIpcMethods } from "./DesktopIpcHandlers";

const isInvokeDescriptor = (
  descriptor:
    | IpcInvokeDescriptor<unknown, unknown>
    | { readonly channel: string },
): descriptor is IpcInvokeDescriptor<unknown, unknown> =>
  "decodePayloadEffect" in descriptor;

const expectedDescriptors = [
  ...Object.values(WindowsIpc),
  ...Object.values(AboutIpc),
  ...Object.values(AccountsIpc),
  ...Object.values(AccountSettingsIpc),
  ...Object.values(ArmyIpc),
  ...Object.values(CombatProfilesIpc),
  ...Object.values(EnvironmentIpc),
  ...Object.values(FileSystemIpc),
  ...Object.values(HttpIpc),
  ...Object.values(FollowerIpc),
  ...Object.values(GameViewsIpc),
  ...Object.values(GameRendererIpc),
  ...Object.values(LoaderGrabberIpc),
  ...Object.values(PacketsIpc),
  ...Object.values(SettingsIpc),
  ...Object.values(ScriptingIpc),
  ...Object.values(UpdatesIpc),
].filter(isInvokeDescriptor);

describe("desktop IPC method inventory", () => {
  it("registers every invoke descriptor exactly once", () => {
    const actualChannels = desktopIpcMethods
      .map((method) => method.descriptor.channel)
      .toSorted();
    const expectedChannels = expectedDescriptors
      .map((descriptor) => descriptor.channel)
      .toSorted();

    expect(actualChannels).toEqual(expectedChannels);
    expect(new Set(actualChannels).size).toBe(actualChannels.length);
  });
});
