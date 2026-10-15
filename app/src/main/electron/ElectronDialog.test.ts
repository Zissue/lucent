import type { MessageBoxOptions } from "electron";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";

import { ElectronDialog, layer } from "./ElectronDialog";

const mocks = vi.hoisted(() => ({
  window: { id: 42 },
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  BaseWindow: { fromId: () => mocks.window },
  dialog: { showMessageBox: mocks.showMessageBox },
}));

describe("Electron message box interruption", () => {
  for (const parentWindowId of [undefined, 42]) {
    it.effect(`aborts the message box with parent ${parentWindowId}`, () =>
      Effect.gen(function* () {
        const shown = yield* Deferred.make<MessageBoxOptions>();
        mocks.showMessageBox.mockImplementationOnce(
          (...args: [MessageBoxOptions] | [unknown, MessageBoxOptions]) => {
            Deferred.doneUnsafe(
              shown,
              Effect.succeed(args.length === 1 ? args[0] : args[1]),
            );
            return new Promise(() => {});
          },
        );
        const dialog = yield* ElectronDialog;
        const fiber = yield* dialog
          .showMessageBox({ message: "Update available" }, parentWindowId)
          .pipe(Effect.forkChild);
        const options = yield* Deferred.await(shown);
        expect(options.message).toBe("Update available");

        yield* Fiber.interrupt(fiber);

        expect(options.signal?.aborted).toBe(true);
      }).pipe(Effect.provide(layer)),
    );
  }
});
