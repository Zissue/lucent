import { EventEmitter } from "node:events";
import { app, ipcMain } from "electron";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { DiagnosticsIpc, GameConsoleIpc } from "../../../shared/ipc";
import { installDesktopRendererObservability } from "./DesktopRendererObservability";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), ipcMain: new EventEmitter() };
});

describe("DesktopRendererObservability", () => {
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
            ipcMain.emit(
              DiagnosticsIpc.rendererRecord.channel,
              { sender: contents },
              { type: "invalid" },
            );
            ipcMain.emit(
              GameConsoleIpc.rendererMessage.channel,
              { sender: contents },
              { message: 42 },
            );
            ipcMain.emit(
              GameConsoleIpc.rendererMessage.channel,
              { sender: contents },
              { message: "hello" },
            );
            ipcMain.emit(
              DiagnosticsIpc.rendererRecord.channel,
              { sender: contents },
              {
                type: "renderer.error",
                error: {
                  name: "TypeError",
                  message: "bad view",
                  stack: "renderer stack",
                },
                observedAt: "2026-10-12T12:00:00.000Z",
                view: "game",
                source: "game.js",
                lineNumber: 12,
                columnNumber: 3,
              },
            );
            ipcMain.emit(
              DiagnosticsIpc.rendererRecord.channel,
              { sender: contents },
              {
                type: "renderer.unhandled-rejection",
                error: { name: "Error", message: "request failed" },
                observedAt: "2026-10-12T12:01:00.000Z",
                view: "game",
              },
            );
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
              "https://example.com/game",
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
        ipcMain.emit(
          GameConsoleIpc.rendererMessage.channel,
          { sender: contents },
          { message: "after close" },
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
            level: "Debug",
            message: ["Renderer console message"],
            component: "renderer",
            data: { message: "hello", rendererId: 42 },
          },
          {
            level: "Error",
            message: ["Renderer error"],
            component: "renderer",
            data: {
              rendererId: 42,
              error: {
                name: "TypeError",
                message: "bad view",
                stack: "renderer stack",
              },
              observedAt: "2026-10-12T12:00:00.000Z",
              view: "game",
              source: "game.js",
              lineNumber: 12,
              columnNumber: 3,
            },
          },
          {
            level: "Error",
            message: ["Renderer unhandled rejection"],
            component: "renderer",
            data: {
              rendererId: 42,
              error: { name: "Error", message: "request failed" },
              observedAt: "2026-10-12T12:01:00.000Z",
              view: "game",
            },
          },
          {
            level: "Error",
            message: ["Renderer process gone"],
            component: "renderer",
            data: { rendererId: 42, reason: "crashed", exitCode: 1 },
          },
          {
            level: "Info",
            message: ["Renderer process gone"],
            component: "renderer",
            data: { rendererId: 42, reason: "clean-exit", exitCode: 0 },
          },
          {
            level: "Error",
            message: ["Child process gone"],
            component: "process",
            data: { type: "GPU", reason: "crashed", exitCode: 2 },
          },
          {
            level: "Info",
            message: ["Child process gone"],
            component: "process",
            data: { type: "Utility", reason: "clean-exit", exitCode: 0 },
          },
          {
            level: "Warn",
            message: ["Renderer load failed"],
            component: "renderer",
            data: {
              rendererId: 42,
              errorCode: -7,
              errorDescription: "Timed out",
              validatedUrl: "https://example.com/game",
              isMainFrame: true,
            },
          },
          {
            level: "Warn",
            message: ["Renderer unresponsive"],
            component: "renderer",
            data: { rendererId: 42 },
          },
          {
            level: "Info",
            message: ["Renderer responsive"],
            component: "renderer",
            data: { rendererId: 42 },
          },
        ]);
      }),
  );
});
