import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../shared/desktopBridge";

const electron = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: DesktopBridge) => {
      electron.bridge = bridge;
    },
  },
  ipcRenderer: { send: electron.send, on: vi.fn(), invoke: vi.fn() },
}));

const argv = process.argv;
let events: EventTarget;

beforeEach(() => {
  vi.resetModules();
  electron.send.mockReset();
  electron.bridge = undefined;
  events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("navigation", new EventTarget());
  process.argv = [...argv, "--lucent__view=game"];
});

afterEach(() => {
  process.argv = argv;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const loadBridge = async () => {
  await import("./preload");
  if (electron.bridge === undefined)
    throw new Error("Preload did not expose desktop");
  return electron.bridge;
};

describe("preload log bridge", () => {
  it("exposes all log levels outside debug mode with the view and error details", async () => {
    const bridge = await loadBridge();
    const error = new Error("x");
    error.stack = "error stack";
    bridge.log.error("Failed", error);
    bridge.log.warn("Warning", "plain cause");
    bridge.log.info("Ready");
    bridge.log.debug("Detail");
    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "error",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          error: [{ name: "Error", message: "x", stack: "error stack" }],
        },
      ],
      [
        "desktop:renderer-log:record",
        {
          level: "warn",
          message: "Warning",
          component: "renderer",
          data: { view: "game" },
          error: [{ name: "NonError", message: "plain cause" }],
        },
      ],
      [
        "desktop:renderer-log:record",
        {
          level: "info",
          message: "Ready",
          component: "renderer",
          data: { view: "game" },
        },
      ],
      [
        "desktop:renderer-log:record",
        {
          level: "debug",
          message: "Detail",
          component: "renderer",
          data: { view: "game" },
        },
      ],
    ]);
  });

  it("serializes write payloads and drops serialization, error conversion, and send failures", async () => {
    const bridge = await loadBridge();
    bridge.log.write({ level: "info", message: "Count", data: { count: 42n } });
    bridge.log.write({
      level: "info",
      message: "Broken",
      data: {
        toJSON() {
          throw new Error("bad json");
        },
      },
    });
    const error = new Error("bad getter");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("bad getter");
      },
    });
    bridge.log.error("Broken error", error);
    electron.send.mockImplementationOnce(() => {
      throw new Error("closed");
    });
    bridge.log.warn("Closed");
    bridge.log.info("Recovered");
    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        { level: "info", message: "Count", data: { count: "42" } },
      ],
      [
        "desktop:renderer-log:record",
        {
          level: "warn",
          message: "Closed",
          component: "renderer",
          data: { view: "game" },
        },
      ],
      [
        "desktop:renderer-log:record",
        {
          level: "info",
          message: "Recovered",
          component: "renderer",
          data: { view: "game" },
        },
      ],
    ]);
  });

  for (const debug of [false, true]) {
    it(`keeps global error hooks and console forwarding gated with debug=${debug}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
      if (debug)
        process.argv.push(
          "--lucent__debug",
          "--lucent__gameConsoleObservability",
        );
      const bridge = await loadBridge();
      const error = new Error("bad view");
      error.stack = "renderer stack";
      events.dispatchEvent(
        Object.assign(new Event("error"), {
          error,
          message: "bad view",
          colno: 3,
          lineno: 12,
          filename: "game.js",
        }),
      );
      events.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: "request failed",
        }),
      );
      if (bridge.view !== "game") throw new Error("Expected game bridge");
      bridge.gameConsoleObservability?.message("warn", "hello");
      bridge.log.info("Ready");
      expect(electron.send.mock.calls).toEqual([
        ...(debug
          ? [
              [
                "desktop:renderer-log:record",
                {
                  level: "error",
                  message: "Renderer error",
                  component: "renderer",
                  data: {
                    columnNumber: 3,
                    lineNumber: 12,
                    observedAt: "2026-10-14T12:00:00.000Z",
                    source: "game.js",
                    view: "game",
                  },
                  error: [
                    {
                      name: "Error",
                      message: "bad view",
                      stack: "renderer stack",
                    },
                  ],
                },
              ],
              [
                "desktop:renderer-log:record",
                {
                  level: "error",
                  message: "Renderer unhandled rejection",
                  component: "renderer",
                  data: {
                    observedAt: "2026-10-14T12:00:00.000Z",
                    view: "game",
                  },
                  error: [{ name: "NonError", message: "request failed" }],
                },
              ],
              [
                "desktop:renderer-log:record",
                {
                  level: "debug",
                  message: "Renderer console message",
                  component: "renderer",
                  data: { method: "warn", message: "hello" },
                },
              ],
            ]
          : []),
        [
          "desktop:renderer-log:record",
          {
            level: "info",
            message: "Ready",
            component: "renderer",
            data: { view: "game" },
          },
        ],
      ]);
      expect(bridge.gameConsoleObservability === undefined).toBe(!debug);
    });
  }
});
