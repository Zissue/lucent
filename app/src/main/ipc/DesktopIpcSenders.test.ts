import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { makeLifetime } from "../window/RendererLifetimeTesting";

import type { DesktopRendererKind } from "../window/DesktopWindowCatalog";
import { DesktopWindows } from "../window/DesktopWindows";
import { ALL_DESKTOP_RENDERER_KINDS } from "./DesktopIpc";
import {
  DesktopIpcSenderError,
  makeDesktopIpcSenders,
  resolveGameRendererId,
} from "./DesktopIpcSenders";

const event = { sender: { id: 42 } };
const makeWindows = (kind: DesktopRendererKind | null) => {
  const lifetimes = new Map(kind === null ? [] : [[42, makeLifetime(42)]]);
  return {
    lifetimes,
    identify: (rendererId: number) =>
      Effect.sync(() => {
        const lifetime = lifetimes.get(rendererId);
        return kind === null || lifetime === undefined
          ? undefined
          : { rendererId, kind, lifetime };
      }),
  };
};

describe("DesktopIpcSenders", () => {
  it.effect("resolves an allowed sender with its managed window identity", () =>
    Effect.gen(function* () {
      const windows = makeWindows("game");
      const senders = makeDesktopIpcSenders(windows);

      const sender = yield* senders.require(event, ["game"]);

      expect(sender.rendererId).toBe(42);
      expect(sender.kind).toBe("game");
      expect(sender.lifetime.isCurrent()).toBe(true);

      yield* Scope.close(windows.lifetimes.get(42)!.scope, Exit.void);
      windows.lifetimes.set(42, makeLifetime(42, 2));

      expect(sender.lifetime.isCurrent()).toBe(false);
    }),
  );

  it.effect("rejects a managed window of the wrong kind", () =>
    Effect.gen(function* () {
      const senders = makeDesktopIpcSenders(makeWindows("settings"));

      const error = yield* Effect.flip(senders.require(event, ["game"]));

      expect(error).toBeInstanceOf(DesktopIpcSenderError);
      expect(error.message).toBe("IPC sender must be one of: game");
    }),
  );

  it.effect("rejects unmanaged web contents", () =>
    Effect.gen(function* () {
      const unmanagedWindows = makeWindows(null);
      const unmanagedSenders = makeDesktopIpcSenders(unmanagedWindows);

      const error = yield* Effect.flip(
        unmanagedSenders.require(event, ["game"]),
      );

      expect(error).toBeInstanceOf(DesktopIpcSenderError);
      expect(error.message).toBe("IPC sender must be one of: game");
    }),
  );

  it.effect(
    "lists all renderer kinds in order when rejecting unmanaged contents",
    () =>
      Effect.gen(function* () {
        const senders = makeDesktopIpcSenders(makeWindows(null));

        const error = yield* Effect.flip(
          senders.require(event, ALL_DESKTOP_RENDERER_KINDS),
        );

        expect(error.message).toBe(
          "IPC sender must be one of: about, account-manager, combat-profiles, environment, follower, game, game-group-controls, game-host, loader-grabber, packets, settings",
        );
      }),
  );

  it.effect("routes child windows to their live game owner", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveGameRendererId({ rendererId: 42, kind: "game" }).pipe(
          Effect.provide(Layer.mock(DesktopWindows, {})),
        ),
      ).toBe(42);
      expect(
        yield* resolveGameRendererId({ rendererId: 8, kind: "packets" }).pipe(
          Effect.provide(
            Layer.mock(DesktopWindows, {
              describe: (rendererId) =>
                Effect.succeed({
                  rendererId,
                  kind: rendererId === 8 ? "packets" : "game",
                  windowId: 1,
                  ownerId: rendererId === 8 ? 42 : undefined,
                  generation: 1,
                  ready: false,
                }),
            }),
          ),
        ),
      ).toBe(42);
      for (const kind of [null, "settings"] as const) {
        const error = yield* resolveGameRendererId({
          rendererId: 8,
          kind: "packets",
        }).pipe(
          Effect.provide(
            Layer.mock(DesktopWindows, {
              describe: (rendererId) =>
                Effect.succeed(
                  rendererId === 8
                    ? {
                        rendererId,
                        kind: "packets",
                        windowId: 1,
                        ownerId: 42,
                        generation: 1,
                        ready: false,
                      }
                    : kind === null
                      ? undefined
                      : {
                          rendererId,
                          kind,
                          windowId: 1,
                          ownerId: 42,
                          generation: 1,
                          ready: false,
                        },
                ),
            }),
          ),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(DesktopIpcSenderError);
        expect(error.detail).toBe(
          "This window is no longer linked to a game. Reopen it from the game.",
        );
      }
    }),
  );
});
