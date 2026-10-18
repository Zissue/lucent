import { runInThisContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../shared/desktopBridge";

const electron = vi.hoisted(() => ({
  bridge: undefined as DesktopBridge | undefined,
  invoke: vi.fn(),
  page: new EventTarget(),
  pageFunctions: new WeakSet<object>(),
  send: vi.fn(),
}));

vi.mock("electron", () => {
  const copyErrorArguments = (args: unknown[]): unknown[] =>
    args.map((value) => {
      if (!(value instanceof Error)) return value;
      const error = new Error(value.message);
      error.stack = `Error: ${value.message}`;
      return error;
    });

  const rememberPageFunctions = (value: unknown): void => {
    if (typeof value === "function") {
      electron.pageFunctions.add(value);
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) rememberPageFunctions(entry);
    }
  };

  const exposeValue = (value: unknown): unknown => {
    if (typeof value === "function") {
      return electron.pageFunctions.has(value)
        ? value
        : (...args: unknown[]) => value(...copyErrorArguments(args));
    }
    if (Array.isArray(value)) return Object.freeze(value.map(exposeValue));
    if (value !== null && typeof value === "object") {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            exposeValue(entry),
          ]),
        ),
      );
    }
    return value;
  };

  return {
    contextBridge: {
      executeInMainWorld: ({
        func,
        args,
      }: {
        func: (...args: unknown[]) => unknown;
        args: unknown[];
      }) => {
        const preloadWindow = window;
        vi.stubGlobal("window", electron.page);
        try {
          const result: unknown = runInThisContext(`(${func.toString()})`)(
            ...args.map((value) =>
              typeof value === "function"
                ? (...callbackArgs: unknown[]) =>
                    value(...copyErrorArguments(callbackArgs))
                : value,
            ),
          );
          rememberPageFunctions(result);
          return result;
        } finally {
          vi.stubGlobal("window", preloadWindow);
        }
      },
      exposeInMainWorld: (_name: string, bridge: DesktopBridge) => {
        electron.bridge = exposeValue(bridge) as DesktopBridge;
      },
    },
    ipcRenderer: { send: electron.send, on: vi.fn(), invoke: electron.invoke },
  };
});

const argv = process.argv;
let events: EventTarget;

beforeEach(() => {
  vi.resetModules();
  electron.send.mockReset();
  electron.invoke.mockReset();
  electron.bridge = undefined;
  electron.page = new EventTarget();
  electron.pageFunctions = new WeakSet();
  events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("navigation", new EventTarget());
  process.argv = [...argv, "--lucent__view=game"];
});

afterEach(() => {
  process.argv = argv;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const loadBridge = async () => {
  await import("./preload");
  if (electron.bridge === undefined)
    throw new Error("Preload did not expose desktop");
  return electron.bridge;
};

describe("preload log bridge", () => {
  it("handles a failed game close without duplicating its main-process log", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    electron.invoke.mockRejectedValue(new Error("Game close failed"));
    const bridge = await loadBridge();
    if (bridge.view !== "game") throw new Error("Expected game bridge");

    bridge.gameView.close();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect({
      invocations: electron.invoke.mock.calls,
      consoleErrors: consoleError.mock.calls,
      forwardedLogs: electron.send.mock.calls,
    }).toEqual({
      invocations: [["desktop:game-views:close-current", undefined]],
      consoleErrors: [],
      forwardedLogs: [],
    });
  });

  it("exposes all log levels outside debug mode with the view and error details", async () => {
    const bridge = await loadBridge();
    const error = new Error("x");
    error.stack = "error stack";
    bridge.log.error("Failed", error);
    bridge.log.warn("Warning", "plain cause");
    bridge.log.info("Ready");
    bridge.log.debug("Detail", undefined);
    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "error",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          repeatKey: "Error:x",
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
          repeatKey: "NonError:plain cause",
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

  it.each(["error", "warn", "info", "debug"] as const)(
    "preserves page-world error names, stacks, and causes at the %s level",
    async (level) => {
      const bridge = await loadBridge();
      const cause = new RangeError("request exhausted");
      cause.stack =
        "RangeError: request exhausted\n    at request (game.js:20:4)";
      const error = new TypeError("load failed", { cause });
      error.stack =
        "TypeError: load failed\n    at load (game.js:12:3)\n    at mount (game.js:4:1)";

      bridge.log[level]("Failed", error);

      expect(electron.send.mock.calls).toEqual([
        [
          "desktop:renderer-log:record",
          {
            level,
            message: "Failed",
            component: "renderer",
            data: { view: "game" },
            repeatKey: "TypeError:at load (game.js:12:3)",
            error: [
              {
                name: "TypeError",
                message: "load failed",
                stack:
                  "TypeError: load failed\n    at load (game.js:12:3)\n    at mount (game.js:4:1)",
                cause: {
                  name: "RangeError",
                  message: "request exhausted",
                  stack:
                    "RangeError: request exhausted\n    at request (game.js:20:4)",
                },
              },
            ],
          },
        ],
      ]);
    },
  );

  it("keeps the root error and five causes from a longer page-world cause chain", async () => {
    const bridge = await loadBridge();
    let error: Error | undefined;
    for (const message of [
      "discarded",
      "fifth",
      "fourth",
      "third",
      "second",
      "first",
      "root",
    ]) {
      error = new Error(message, { cause: error });
      error.stack = `Error: ${message}`;
    }

    bridge.log.error("Failed", error);

    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "error",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          repeatKey: "Error:root",
          error: [
            {
              name: "Error",
              message: "root",
              stack: "Error: root",
              cause: {
                name: "Error",
                message: "first",
                stack: "Error: first",
                cause: {
                  name: "Error",
                  message: "second",
                  stack: "Error: second",
                  cause: {
                    name: "Error",
                    message: "third",
                    stack: "Error: third",
                    cause: {
                      name: "Error",
                      message: "fourth",
                      stack: "Error: fourth",
                      cause: {
                        name: "Error",
                        message: "fifth",
                        stack: "Error: fifth",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    ]);
  });

  it("bounds cyclic page-world causes to the root error and five causes", async () => {
    const bridge = await loadBridge();
    const error = new Error("cycle");
    error.stack = "Error: cycle";
    error.cause = error;

    bridge.log.error("Failed", error);

    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "error",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          repeatKey: "Error:cycle",
          error: [
            {
              name: "Error",
              message: "cycle",
              stack: "Error: cycle",
              cause: {
                name: "Error",
                message: "cycle",
                stack: "Error: cycle",
                cause: {
                  name: "Error",
                  message: "cycle",
                  stack: "Error: cycle",
                  cause: {
                    name: "Error",
                    message: "cycle",
                    stack: "Error: cycle",
                    cause: {
                      name: "Error",
                      message: "cycle",
                      stack: "Error: cycle",
                      cause: {
                        name: "Error",
                        message: "cycle",
                        stack: "Error: cycle",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    ]);
  });

  it("preserves non-Error page-world causes", async () => {
    const bridge = await loadBridge();
    const error = new TypeError("load failed", { cause: "request failed" });
    error.stack = "TypeError: load failed\n    at load (game.js:12:3)";

    bridge.log.warn("Failed", error);

    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "warn",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          repeatKey: "TypeError:at load (game.js:12:3)",
          error: [
            {
              name: "TypeError",
              message: "load failed",
              stack: "TypeError: load failed\n    at load (game.js:12:3)",
              cause: { name: "NonError", message: "request failed" },
            },
          ],
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

  for (const { debug, consoleObservability } of [
    { debug: false, consoleObservability: false },
    { debug: false, consoleObservability: true },
    { debug: true, consoleObservability: false },
    { debug: true, consoleObservability: true },
  ]) {
    it(`reports global errors with debug=${debug} and console forwarding=${consoleObservability}`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
      if (debug) process.argv.push("--lucent__debug");
      if (consoleObservability)
        process.argv.push("--lucent__gameConsoleObservability");
      const bridge = await loadBridge();
      const cause = new RangeError("invalid state");
      cause.stack = "cause stack";
      const error = new Error("bad view", { cause });
      error.stack = "renderer stack";
      electron.page.dispatchEvent(
        Object.assign(new Event("error"), {
          error,
          message: "bad view",
          colno: 3,
          lineno: 12,
          filename: "game.js",
        }),
      );
      electron.page.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: "request failed",
        }),
      );
      if (bridge.view !== "game") throw new Error("Expected game bridge");
      bridge.gameConsoleObservability?.message("warn", "hello");
      bridge.gameConsoleObservability?.message("log", "world");
      bridge.log.info("Ready");
      expect(electron.send.mock.calls).toEqual([
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
            repeatKey: "Error:bad view",
            error: [
              {
                name: "Error",
                message: "bad view",
                stack: "renderer stack",
                cause: {
                  name: "RangeError",
                  message: "invalid state",
                  stack: "cause stack",
                },
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
            repeatKey: "NonError:request failed",
            error: [{ name: "NonError", message: "request failed" }],
          },
        ],
        ...(debug && consoleObservability
          ? [
              [
                "desktop:renderer-log:record",
                {
                  level: "debug",
                  message: "Renderer console message",
                  component: "renderer",
                  data: { method: "warn", message: "hello" },
                  repeatKey: "hello",
                },
              ],
              [
                "desktop:renderer-log:record",
                {
                  level: "debug",
                  message: "Renderer console message",
                  component: "renderer",
                  data: { method: "log", message: "world" },
                  repeatKey: "world",
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
      expect(bridge.gameConsoleObservability === undefined).toBe(
        !(debug && consoleObservability),
      );
    });
  }

  it("omits URL credentials, queries, fragments, and schemes from error repeat keys", async () => {
    const bridge = await loadBridge();
    const error = new Error("bad view");
    error.stack =
      "Error: bad view\n    at mount (https://user:p@ss@assets.example/game.js?token=secret#section:12:3)";
    bridge.log.error("Failed", error);
    expect(electron.send.mock.calls).toEqual([
      [
        "desktop:renderer-log:record",
        {
          level: "error",
          message: "Failed",
          component: "renderer",
          data: { view: "game" },
          repeatKey: "Error:at mount (assets.example/game.js:12:3)",
          error: [
            {
              name: "Error",
              message: "bad view",
              stack:
                "Error: bad view\n    at mount (https://user:p@ss@assets.example/game.js?token=secret#section:12:3)",
            },
          ],
        },
      ],
    ]);
  });

  it("separates global error identities by name, first stack frame, and fallback message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    await loadBridge();
    const mountError = new Error("bad view");
    mountError.stack =
      "Error: bad view\n    at mount (game.js:12:3)\n    at render (game.js:4:1)";
    const updateError = new Error("bad view");
    updateError.stack = "Error: bad view\n    at update (game.js:15:2)";
    const typeError = new TypeError("bad view");
    typeError.stack = "TypeError: bad view\n    at mount (game.js:12:3)";
    for (const error of [mountError, updateError, typeError]) {
      electron.page.dispatchEvent(
        Object.assign(new Event("error"), {
          error,
          message: "bad view",
          colno: 0,
          lineno: 0,
          filename: "",
        }),
      );
    }
    for (const reason of [
      "first request failed",
      "second request failed",
      undefined,
    ]) {
      electron.page.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), { reason }),
      );
    }
    expect(electron.send.mock.calls.map(([, record]) => record)).toEqual([
      {
        level: "error",
        message: "Renderer error",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "Error:at mount (game.js:12:3)",
        error: [
          {
            name: "Error",
            message: "bad view",
            stack:
              "Error: bad view\n    at mount (game.js:12:3)\n    at render (game.js:4:1)",
          },
        ],
      },
      {
        level: "error",
        message: "Renderer error",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "Error:at update (game.js:15:2)",
        error: [
          {
            name: "Error",
            message: "bad view",
            stack: "Error: bad view\n    at update (game.js:15:2)",
          },
        ],
      },
      {
        level: "error",
        message: "Renderer error",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "TypeError:at mount (game.js:12:3)",
        error: [
          {
            name: "TypeError",
            message: "bad view",
            stack: "TypeError: bad view\n    at mount (game.js:12:3)",
          },
        ],
      },
      {
        level: "error",
        message: "Renderer unhandled rejection",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "NonError:first request failed",
        error: [{ name: "NonError", message: "first request failed" }],
      },
      {
        level: "error",
        message: "Renderer unhandled rejection",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "NonError:second request failed",
        error: [{ name: "NonError", message: "second request failed" }],
      },
      {
        level: "error",
        message: "Renderer unhandled rejection",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "NonError:undefined",
        error: [{ name: "NonError", message: "undefined" }],
      },
    ]);
  });

  it("reports rejections from the preload's own world", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    await loadBridge();
    events.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: "listener failed",
      }),
    );
    expect(electron.send.mock.calls.map(([, record]) => record)).toEqual([
      {
        level: "error",
        message: "Renderer unhandled rejection",
        component: "renderer",
        data: { observedAt: "2026-10-14T12:00:00.000Z", view: "game" },
        repeatKey: "NonError:listener failed",
        error: [{ name: "NonError", message: "listener failed" }],
      },
    ]);
  });
});
