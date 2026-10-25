import type { WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopRendererKind } from "../window/DesktopWindowCatalog";
import {
  DesktopWindows,
  type DesktopRendererInfo,
} from "../window/DesktopWindows";

export type DesktopIpcSender = Pick<
  DesktopRendererInfo,
  "rendererId" | "kind" | "lifetime"
>;

export type DesktopIpcSenderKinds = readonly [
  DesktopRendererKind,
  ...DesktopRendererKind[],
];

export class DesktopIpcSenderError extends Schema.TaggedError<DesktopIpcSenderError>()(
  "DesktopIpcSenderError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const requireSender = Effect.fnUntraced(function* (
  windows: Pick<DesktopWindows["Service"], "describe">,
  event: { readonly sender: Pick<WebContents, "id"> },
  allowedKinds: DesktopIpcSenderKinds,
) {
  const info = yield* windows.describe(event.sender.id);
  if (info === undefined || !allowedKinds.includes(info.kind)) {
    return yield* new DesktopIpcSenderError({
      detail: `IPC sender must be one of: ${allowedKinds.join(", ")}`,
    });
  }

  return info;
});

export const resolveGameRendererId = Effect.fn(
  "DesktopIpcSenders.resolveGameRendererId",
)(function* (sender: Pick<DesktopIpcSender, "rendererId" | "kind">) {
  if (sender.kind === "game") return sender.rendererId;
  const windows = yield* DesktopWindows;
  const ownerId = (yield* windows.describe(sender.rendererId))?.ownerId;
  if (
    ownerId === undefined ||
    (yield* windows.describe(ownerId))?.kind !== "game"
  ) {
    return yield* new DesktopIpcSenderError({
      detail:
        "This window is no longer linked to a game. Reopen it from the game.",
    });
  }
  return ownerId;
});
