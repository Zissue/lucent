import * as Schema from "effect/Schema";
import { RecentlyClosedGameSessionSchema } from "@lucent/core/accounts";

import {
  GameViewGroupCommandDispatchResultSchema,
  GameViewGroupCommandDispatchRequestSchema,
  GameViewGroupCommandEnvelopeSchema,
  GameViewGroupOptionHotkeyCommandIdSchema,
  GameViewHostStateSchema,
  GameViewLayoutSchema,
  GameViewPresentationSchema,
  GameViewSelectionFocusSchema,
} from "../gameViews";
import { defineEvent, defineInvoke } from "./core";

const namespace = "desktop:game-views";
const SessionIdPayloadSchema = Schema.Struct({ id: Schema.String });

export const GameViewsIpc = {
  getRecentlyClosed: defineInvoke({
    channel: `${namespace}:get-recently-closed`,
    payload: Schema.Void,
    result: Schema.Array(RecentlyClosedGameSessionSchema),
  }),
  reopen: defineInvoke({
    channel: `${namespace}:reopen`,
    payload: Schema.Struct({ id: Schema.Int }),
    result: GameViewHostStateSchema,
  }),
  getState: defineInvoke({
    channel: `${namespace}:get-state`,
    payload: Schema.Void,
    result: GameViewHostStateSchema,
  }),
  add: defineInvoke({
    channel: `${namespace}:add`,
    payload: Schema.Void,
    result: GameViewHostStateSchema,
  }),
  select: defineInvoke({
    channel: `${namespace}:select`,
    payload: Schema.Struct({
      id: Schema.String,
      focus: GameViewSelectionFocusSchema,
    }),
    result: GameViewHostStateSchema,
  }),
  close: defineInvoke({
    channel: `${namespace}:close`,
    payload: SessionIdPayloadSchema,
    result: Schema.Void,
  }),
  closeCurrent: defineInvoke({
    channel: `${namespace}:close-current`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  reorder: defineInvoke({
    channel: `${namespace}:reorder`,
    payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
    result: GameViewHostStateSchema,
  }),
  setLayout: defineInvoke({
    channel: `${namespace}:set-layout`,
    payload: Schema.Struct({ layout: GameViewLayoutSchema }),
    result: GameViewHostStateSchema,
  }),
  setGroupTargets: defineInvoke({
    channel: `${namespace}:set-group-targets`,
    payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
    result: GameViewHostStateSchema,
  }),
  setGroupControlsOpen: defineInvoke({
    channel: `${namespace}:set-group-controls-open`,
    payload: Schema.Struct({ open: Schema.Boolean }),
    result: GameViewHostStateSchema,
  }),
  setTabMenuOpen: defineInvoke({
    channel: `${namespace}:set-tab-menu-open`,
    payload: Schema.Struct({ open: Schema.Boolean }),
    result: Schema.Boolean,
  }),
  syncTabBarLayout: defineInvoke({
    channel: `${namespace}:sync-tab-bar-layout`,
    payload: Schema.Void,
    result: Schema.Void,
  }),
  dispatchGroupCommand: defineInvoke({
    channel: `${namespace}:dispatch-group-command`,
    payload: GameViewGroupCommandDispatchRequestSchema,
    result: GameViewGroupCommandDispatchResultSchema,
  }),
  dispatchGroupOptionHotkey: defineInvoke({
    channel: `${namespace}:dispatch-group-option-hotkey`,
    payload: Schema.Struct({
      commandId: GameViewGroupOptionHotkeyCommandIdSchema,
    }),
    result: GameViewGroupCommandDispatchResultSchema,
  }),
  getPresentation: defineInvoke({
    channel: `${namespace}:get-presentation`,
    payload: Schema.Void,
    result: GameViewPresentationSchema,
  }),
  changed: defineEvent({
    channel: `${namespace}:changed`,
    payload: GameViewHostStateSchema,
  }),
  presentationChanged: defineEvent({
    channel: `${namespace}:presentation-changed`,
    payload: GameViewPresentationSchema,
  }),
  shortcutModifierChanged: defineEvent({
    channel: `${namespace}:shortcut-modifier-changed`,
    payload: Schema.Boolean,
  }),
  tabMenuOpenChanged: defineEvent({
    channel: `${namespace}:tab-menu-open-changed`,
    payload: Schema.Boolean,
  }),
  groupCommand: defineEvent({
    channel: `${namespace}:group-command`,
    payload: GameViewGroupCommandEnvelopeSchema,
  }),
} as const;
