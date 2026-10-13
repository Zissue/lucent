import type { WebContents } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { DesktopRendererKind } from "../window/DesktopWindowCatalog";
import { DesktopWindows } from "../window/DesktopWindows";

export interface DesktopIpcSender {
  readonly rendererId: number;
  readonly kind: DesktopRendererKind;
  readonly isCurrent: () => boolean;
}

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

export interface DesktopIpcSendersShape {
  readonly require: (
    event: { readonly sender: Pick<WebContents, "id"> },
    allowedKinds: DesktopIpcSenderKinds,
  ) => Effect.Effect<DesktopIpcSender, DesktopIpcSenderError>;
}

export class DesktopIpcSenders extends Context.Service<
  DesktopIpcSenders,
  DesktopIpcSendersShape
>()("lucent/desktop/ipc/DesktopIpcSenders") {}

export const makeDesktopIpcSenders = (
  windows: Pick<DesktopWindows["Service"], "describe" | "generationGuard">,
): DesktopIpcSenders["Service"] => {
  const requireSender = Effect.fn("DesktopIpcSenders.require")(function* (
    event: { readonly sender: Pick<WebContents, "id"> },
    allowedKinds: DesktopIpcSenderKinds,
  ) {
    const rendererId = event.sender.id;
    const info = yield* windows.describe(rendererId);
    if (info === undefined || !allowedKinds.includes(info.kind)) {
      return yield* new DesktopIpcSenderError({
        detail: `IPC sender must be one of: ${allowedKinds.join(", ")}`,
      });
    }

    return {
      rendererId,
      kind: info.kind,
      isCurrent: yield* windows.generationGuard(rendererId, info.generation),
    };
  });

  return DesktopIpcSenders.of({
    require: requireSender,
  });
};

export const layer = Layer.effect(
  DesktopIpcSenders,
  Effect.gen(function* () {
    const windows = yield* DesktopWindows;
    return makeDesktopIpcSenders(windows);
  }),
);

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
