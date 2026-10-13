import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { AccountManagerState } from "@lucent/core/accounts";
import type { CombatProfileLibrary } from "@lucent/core/combatProfiles";
import type { ScriptCatalogChange } from "@lucent/core/scriptPackages";
import { normalizeAppSettings } from "@lucent/core/settings";

import type { UpdateCheckState } from "../../../shared/updates";
import {
  makeListenerRegistry,
  type ListenerRegistry,
} from "../../app/ListenerRegistry";
import { Accounts } from "../../internal/accounts/Accounts";
import { CombatProfiles } from "../../internal/combat-profiles/CombatProfiles";
import { ScriptPackageCatalog } from "../../scripting/ScriptPackageCatalog";
import { DesktopSettings } from "../../settings/DesktopSettings";
import { DesktopUpdates } from "../../updates/DesktopUpdates";
import type { DesktopWindowKind } from "../../window/DesktopWindowCatalog";
import { DesktopWindows } from "../../window/DesktopWindows";
import { DesktopIpc, makeDesktopIpc } from "../DesktopIpc";
import * as AccountsIpcMethods from "./accounts";
import * as CombatProfilesIpcMethods from "./combatProfiles";
import * as ScriptingIpcMethods from "./scripting";
import * as SettingsIpcMethods from "./settings";
import * as UpdatesIpcMethods from "./updates";

const rendererKinds = [
  "account-manager",
  "game",
  "settings",
] as const satisfies readonly DesktopWindowKind[];
type RendererKind = (typeof rendererKinds)[number];

const rendererLayer = (
  send: (kind: RendererKind, channel: string, payload: unknown) => void,
) => {
  const renderers = rendererKinds.map((kind, index) => ({
    id: index + 1,
    kind,
    contents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => send(kind, channel, payload),
    },
  }));
  return Layer.mergeAll(
    Layer.succeed(
      DesktopIpc,
      makeDesktopIpc(
        { handle: () => undefined, removeHandler: () => undefined },
        {
          getAllWebContents: () => renderers.map(({ contents }) => contents),
          fromId: (id) =>
            renderers.find((renderer) => renderer.id === id)?.contents,
        },
      ),
    ),
    Layer.mock(DesktopWindows, {
      getRendererIds: (kind) =>
        Effect.succeed(
          renderers
            .filter((renderer) => renderer.kind === kind)
            .map((renderer) => renderer.id),
        ),
    }),
  );
};

const forwardingCase = <Value, Service>(options: {
  readonly name: string;
  readonly channel: string;
  readonly recipients: readonly RendererKind[];
  readonly payload: Value;
  readonly service: (
    subscribe: ListenerRegistry<Value>["subscribe"],
  ) => Layer.Layer<Service>;
  readonly install: () => Effect.Effect<
    void,
    never,
    Service | DesktopIpc | DesktopWindows | Scope.Scope
  >;
}) => ({
  ...options,
  publish: (
    send: (kind: RendererKind, channel: string, payload: unknown) => void,
    laterListener: () => void,
  ) => {
    const registry = makeListenerRegistry<Value>();
    return Effect.gen(function* () {
      yield* options
        .install()
        .pipe(Effect.provide(options.service(registry.subscribe)));
      yield* registry.subscribe(laterListener);
      yield* registry.publish(options.payload);
    }).pipe(Effect.provide(rendererLayer(send)), Effect.scoped);
  },
});

const accountsState: AccountManagerState = {
  accounts: [],
  groups: {},
  sessions: [],
  storagePath: "/accounts.json",
};
const library: CombatProfileLibrary = { version: 1, profiles: [] };
const catalogChange: ScriptCatalogChange = { revision: "r1" };
const updateState: UpdateCheckState = {
  status: "idle",
  currentVersion: "1.0.0",
};

const forwardings = [
  forwardingCase({
    name: "settings",
    channel: "desktop:settings:changed",
    recipients: rendererKinds,
    payload: normalizeAppSettings({}),
    service: (onChanged) => Layer.mock(DesktopSettings, { onChanged }),
    install: SettingsIpcMethods.installEventForwarding,
  }),
  forwardingCase({
    name: "accounts",
    channel: "desktop:accounts:changed",
    recipients: ["account-manager"],
    payload: accountsState,
    service: (onChanged) => Layer.mock(Accounts, { onChanged }),
    install: AccountsIpcMethods.installEventForwarding,
  }),
  forwardingCase({
    name: "combat profiles",
    channel: "desktop:combat-profiles:changed",
    recipients: rendererKinds,
    payload: library,
    service: (onChanged) => Layer.mock(CombatProfiles, { onChanged }),
    install: CombatProfilesIpcMethods.installEventForwarding,
  }),
  forwardingCase({
    name: "script catalog",
    channel: "desktop:scripting:catalog-changed",
    recipients: ["game"],
    payload: catalogChange,
    service: (onChanged) => Layer.mock(ScriptPackageCatalog, { onChanged }),
    install: ScriptingIpcMethods.installEventForwarding,
  }),
  forwardingCase({
    name: "updates",
    channel: "desktop:updates:changed",
    recipients: rendererKinds,
    payload: updateState,
    service: (onStateChanged) => Layer.mock(DesktopUpdates, { onStateChanged }),
    install: UpdatesIpcMethods.installEventForwarding,
  }),
];

describe("IPC event forwarding", () => {
  for (const forwarding of forwardings) {
    it.effect(
      `delivers ${forwarding.name} changes to renderers before later listeners`,
      () =>
        Effect.gen(function* () {
          const events: unknown[] = [];
          yield* forwarding.publish(
            (kind, channel, payload) => {
              events.push([kind, channel, payload]);
            },
            () => {
              events.push("later listener");
            },
          );
          expect(events).toEqual([
            ...forwarding.recipients.map((kind) => [
              kind,
              forwarding.channel,
              forwarding.payload,
            ]),
            "later listener",
          ]);
        }),
    );
  }
});
