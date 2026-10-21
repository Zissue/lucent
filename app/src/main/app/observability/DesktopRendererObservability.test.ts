import { EventEmitter } from "node:events";
import { app } from "electron";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { installDesktopRendererObservability } from "./DesktopRendererObservability";

vi.mock("effect/Effect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("effect/Effect")>()),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter() };
});

describe("DesktopRendererObservability", () => {
  it.effect(
    "removes only the destroyed WebContents listeners immediately",
    () =>
      Effect.gen(function* () {
        const first = Object.assign(new EventEmitter(), { id: 42 });
        const second = Object.assign(new EventEmitter(), { id: 43 });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installDesktopRendererObservability;
            app.emit("web-contents-created", {}, first);
            app.emit("web-contents-created", {}, second);
            expect(first.listenerCount("responsive")).toBe(1);
            expect(second.listenerCount("responsive")).toBe(1);
            first.emit("destroyed");
            expect(first.eventNames()).toEqual([]);
            expect(second.listenerCount("responsive")).toBe(1);
            first.emit("destroyed");
          }),
        );
        expect(second.eventNames()).toEqual([]);
        expect(app.listenerCount("web-contents-created")).toBe(0);
      }),
  );

  it.effect("interrupts in-flight callback logging when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events: string[] = [];
      const log = vi.spyOn(Effect, "logError").mockReturnValue(
        Effect.gen(function* () {
          events.push("started");
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push("interrupted");
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installDesktopRendererObservability;
            app.emit(
              "child-process-gone",
              {},
              {
                type: "GPU",
                reason: "crashed",
                exitCode: 1,
              },
            );
            yield* Deferred.await(started);
            yield* Effect.yieldNow;
          }),
        );
        expect(events).toEqual(["started", "interrupted"]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Effect.sync(() => log.mockRestore())),
      );
    }),
  );

  it.effect(
    "logs renderer and process events through the captured context",
    () =>
      Effect.gen(function* () {
        const records: unknown[] = [];
        const contents = Object.assign(new EventEmitter(), { id: 42 });
        const logger = Logger.make((options) => {
          records.push({
            level: options.logLevel,
            message: options.message,
            ...options.fiber.getRef(References.CurrentLogAnnotations),
          });
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installDesktopRendererObservability;
            app.emit("render-process-gone", {}, contents, {
              reason: "crashed",
              exitCode: 1,
            });
            app.emit("render-process-gone", {}, contents, {
              reason: "clean-exit",
              exitCode: 0,
            });
            app.emit(
              "child-process-gone",
              {},
              { type: "GPU", reason: "crashed", exitCode: 2 },
            );
            app.emit(
              "child-process-gone",
              {},
              { type: "Utility", reason: "clean-exit", exitCode: 0 },
            );
            app.emit("web-contents-created", {}, contents);
            contents.emit(
              "did-fail-load",
              {},
              -7,
              "Timed out",
              "https://account:secret@example.com:8443/game?token=private#secret",
              true,
            );
            contents.emit("unresponsive");
            contents.emit("responsive");
            yield* Effect.yieldNow;
          }).pipe(
            Effect.provide(Logger.layer([logger])),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          ),
        );
        app.emit(
          "child-process-gone",
          {},
          { type: "GPU", reason: "crashed", exitCode: 1 },
        );
        contents.emit("responsive");
        yield* Effect.yieldNow;

        expect(records).toEqual([
          {
            level: "Error",
            message: ["Renderer process gone"],
            component: "renderer",
            repeatKey: "42:crashed",
            data: { rendererId: 42, reason: "crashed", exitCode: 1 },
          },
          {
            level: "Info",
            message: ["Renderer process gone"],
            component: "renderer",
            repeatKey: "42:clean-exit",
            data: { rendererId: 42, reason: "clean-exit", exitCode: 0 },
          },
          {
            level: "Error",
            message: ["Child process gone"],
            component: "process",
            repeatKey: "GPU:crashed",
            data: { type: "GPU", reason: "crashed", exitCode: 2 },
          },
          {
            level: "Info",
            message: ["Child process gone"],
            component: "process",
            repeatKey: "Utility:clean-exit",
            data: { type: "Utility", reason: "clean-exit", exitCode: 0 },
          },
          {
            level: "Warn",
            message: ["Renderer load failed"],
            component: "renderer",
            repeatKey: "42:-7",
            data: {
              rendererId: 42,
              errorCode: -7,
              errorDescription: "Timed out",
              host: "example.com:8443",
              isMainFrame: true,
            },
          },
          {
            level: "Warn",
            message: ["Renderer unresponsive"],
            component: "renderer",
            repeatKey: "42",
            data: { rendererId: 42 },
          },
          {
            level: "Info",
            message: ["Renderer responsive"],
            component: "renderer",
            repeatKey: "42",
            data: { rendererId: 42 },
          },
        ]);
      }),
  );

  it.effect("skips aborted loads and omits invalid or local URL details", () =>
    Effect.gen(function* () {
      const records: unknown[] = [];
      const contents = Object.assign(new EventEmitter(), { id: 42 });
      const logger = Logger.make((options) => {
        records.push({
          level: options.logLevel,
          message: options.message,
          ...options.fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installDesktopRendererObservability;
          app.emit("web-contents-created", {}, contents);
          for (const [code, description, url] of [
            [-3, "ERR_ABORTED", "https://example.com/?token=private"],
            [-2, "ERR_ABORTED", "https://example.com/?token=private"],
            [-2, "ERR_FAILED", "invalid URL with private data"],
            [
              -6,
              "ERR_FILE_NOT_FOUND",
              "file:///private/local/game.html?secret",
            ],
          ] as const) {
            contents.emit("did-fail-load", {}, code, description, url, true);
          }
          yield* Effect.yieldNow;
        }).pipe(Effect.provide(Logger.layer([logger]))),
      );
      expect(records).toEqual([
        {
          level: "Warn",
          message: ["Renderer load failed"],
          component: "renderer",
          repeatKey: "42:-2",
          data: {
            errorCode: -2,
            errorDescription: "ERR_FAILED",
            isMainFrame: true,
            rendererId: 42,
          },
        },
        {
          level: "Warn",
          message: ["Renderer load failed"],
          component: "renderer",
          repeatKey: "42:-6",
          data: {
            errorCode: -6,
            errorDescription: "ERR_FILE_NOT_FOUND",
            isMainFrame: true,
            rendererId: 42,
          },
        },
      ]);
    }),
  );
});
