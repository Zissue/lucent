import { describe, expect, it } from "@effect/vitest";
import { LiveServer } from "@lucent/game";

import { vi } from "vitest";

import {
  formatConsoleArguments,
  installConsoleForwarder,
} from "./consoleForwarder";

describe("console forwarder", () => {
  it("forwards the console method and retains normal console output", () => {
    const methods = ["debug", "error", "info", "log", "warn"] as const;
    const original = methods.map(
      (method) => [method, console[method]] as const,
    );
    const outputs = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const message = vi.fn();
    try {
      installConsoleForwarder(undefined);
      console.info("Before install");
      installConsoleForwarder({ message });
      for (const method of methods) console[method]("hello", 42);
      expect(message.mock.calls).toEqual([
        ["debug", "hello 42"],
        ["error", "hello 42"],
        ["info", "hello 42"],
        ["log", "hello 42"],
        ["warn", "hello 42"],
      ]);
      expect(outputs.map((output) => output.mock.calls)).toEqual([
        [["hello", 42]],
        [["hello", 42]],
        [["Before install"], ["hello", 42]],
        [["hello", 42]],
        [["hello", 42]],
      ]);
    } finally {
      outputs.forEach((output) => output.mockRestore());
      for (const [method, fn] of original) console[method] = fn;
    }
  });

  it("serializes object console arguments instead of flattening them", () => {
    expect(
      formatConsoleArguments([
        "payload",
        { item: "drop", meta: { quantity: 2 } },
      ]),
    ).toBe(`payload {
  "item": "drop",
  "meta": {
    "quantity": 2
  }
}`);
  });

  it("serializes circular objects and errors", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const error = new Error("boom");

    const message = formatConsoleArguments([circular, error]);

    expect(message).toContain('"self": "[Circular]"');
    expect(message).toContain("Error: boom");
  });

  it("serializes domain models through their normalized snapshot", () => {
    const server = new LiveServer({
      chat: 2,
      count: 100,
      language: "en",
      max: 100,
      memberOnly: false,
      name: "Artix",
      online: true,
    });

    const message = formatConsoleArguments([server]);

    expect(message).toContain('"name": "Artix"');
    expect(message).toContain('"full": true');
  });

  it("caps output length while formatting large object properties", () => {
    const message = formatConsoleArguments([{ payload: "x".repeat(10_000) }], {
      maxChars: 128,
    });

    expect(message.length).toBeLessThanOrEqual(128);
    expect(message).toContain("...[Truncated]");
  });

  it("does not read object properties beyond the configured key cap", () => {
    const reads: string[] = [];
    const payload: Record<string, string> = {};
    for (const key of ["first", "second", "third"]) {
      Object.defineProperty(payload, key, {
        enumerable: true,
        get: () => {
          reads.push(key);
          return key;
        },
      });
    }

    const message = formatConsoleArguments([payload], {
      maxObjectKeys: 2,
    });

    expect(reads).toEqual(["first", "second"]);
    expect(message).toContain("... more properties");
    expect(message).not.toContain('"third"');
  });

  it("does not read array items beyond the configured item cap", () => {
    const reads: string[] = [];
    const payload = ["first", "second", "third"];
    for (const index of [0, 1, 2]) {
      Object.defineProperty(payload, index, {
        enumerable: true,
        get: () => {
          const value = String(index);
          reads.push(value);
          return value;
        },
      });
    }

    const message = formatConsoleArguments([payload], {
      maxArrayItems: 2,
    });

    expect(reads).toEqual(["0", "1"]);
    expect(message).toContain("... 1 more items");
    expect(message).not.toContain('"2"');
  });
});
