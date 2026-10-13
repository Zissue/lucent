import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DesktopRendererKind } from "../window/DesktopWindowCatalog";
import { DesktopWindows } from "../window/DesktopWindows";
import {
  DesktopIpcSenderError,
  makeDesktopIpcSenders,
  resolveGameRendererId,
} from "./DesktopIpcSenders";

const event = { sender: { id: 42 } };
const makeWindows = (kind: DesktopRendererKind | null) => {
  const generations = new Map(kind === null ? [] : [[42, 1]]);
  return {
    generations,
    describe: (rendererId: number) =>
      Effect.sync(() => {
        const generation = generations.get(rendererId);
        return kind === null || generation === undefined
          ? undefined
          : {
              rendererId,
              kind,
              windowId: 1,
              ownerId: undefined,
              generation,
              ready: false,
            };
      }),
    generationGuard: (rendererId: number, generation: number) =>
      Effect.succeed(() => generations.get(rendererId) === generation),
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
      expect(sender.isCurrent()).toBe(true);

      windows.generations.set(42, 2);

      expect(sender.isCurrent()).toBe(false);
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
