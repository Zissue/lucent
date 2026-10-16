import * as Effect from "effect/Effect";

import { WindowsIpc } from "../../../shared/ipc";
import { getDesktopWindowDefinition } from "../../window/DesktopWindowCatalog";
import {
  DesktopWindowError,
  DesktopWindows,
} from "../../window/DesktopWindows";
import { makeDesktopIpcMethod } from "../DesktopIpc";

export const open = makeDesktopIpcMethod({
  descriptor: WindowsIpc.open,
  allowedSenders: ["game", "follower"],
  handler: Effect.fn("desktop.ipc.windows.open")(function* (payload, sender) {
    const windows = yield* DesktopWindows;
    if (sender.kind === "follower" && payload.kind !== "combat-profiles") {
      return yield* new DesktopWindowError({
        detail: "Follower windows may only open combat profiles.",
        id: payload.kind,
      });
    }

    const definition = getDesktopWindowDefinition(payload.kind);
    const ownerRendererId =
      definition.scope !== "game-child"
        ? undefined
        : sender.kind === "game"
          ? sender.rendererId
          : yield* windows.describe(sender.rendererId).pipe(
              Effect.flatMap((info) =>
                info?.ownerId === undefined
                  ? new DesktopWindowError({
                      detail:
                        "This window is no longer linked to a game. Reopen it from the game.",
                      id: String(sender.rendererId),
                    })
                  : Effect.succeed(info.ownerId),
              ),
            );

    const rendererId = yield* windows.open(
      payload.kind,
      ownerRendererId === undefined ? undefined : { ownerRendererId },
    );
    return String(rendererId);
  }),
});

export const methods = [open] as const;
