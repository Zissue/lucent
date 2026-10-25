import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const state = vi.hoisted(() => ({
  locked: false,
  exitCode: 0,
  failure: false,
  lockData: undefined as unknown,
  events: [] as string[],
}));

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: (data: unknown) => {
      state.lockData = data;
      state.events.push("lock");
      return state.locked;
    },
    exit: (code: number) => state.events.push(`exit:${code}`),
  },
}));
vi.mock("./app/Preflight", () => ({
  prepareMainProcess: () => {
    state.events.push("preflight");
    return { cliOptions: {}, envConfig: {} };
  },
}));
vi.mock("./app/Layers", () => ({
  makeDesktopObservabilityLayer: () =>
    state.failure
      ? Layer.effectDiscard(Effect.die(new Error("logger unavailable")))
      : Layer.empty,
  makeDesktopLayer: () => {
    state.events.push("layer");
    return {};
  },
}));
vi.mock("./app/DesktopRuntime", () => ({
  makeDesktopRuntime: (
    _cliOptions: unknown,
    _applicationLayer: unknown,
    observabilityLayer: Layer.Layer<never>,
  ) => {
    state.events.push("runtime");
    return Effect.succeed(state.exitCode).pipe(
      Effect.provide(observabilityLayer),
    );
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.events.length = 0;
  state.lockData = undefined;
  state.exitCode = 0;
  state.failure = false;
  vi.restoreAllMocks();
});

describe("main process single-instance lock", () => {
  it("exits with a handled runtime failure without stderr duplication", async () => {
    state.locked = true;
    state.exitCode = 1;
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await import("./index");
    await vi.waitUntil(() => state.events.includes("exit:1"));
    expect(state.events).toEqual([
      "preflight",
      "lock",
      "layer",
      "runtime",
      "exit:1",
    ]);
    expect(stderr.mock.calls).toEqual([]);
  });

  it("uses stderr when the logger cannot start", async () => {
    state.locked = true;
    state.failure = true;
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await import("./index");
    await vi.waitUntil(() => state.events.includes("exit:1"));
    expect(state.events).toEqual([
      "preflight",
      "lock",
      "layer",
      "runtime",
      "exit:1",
    ]);
    expect(stderr.mock.calls).toEqual([
      ["Lucent desktop runtime failed.", expect.any(Error)],
    ]);
  });

  for (const locked of [false, true]) {
    it(`starts with lock granted ${locked}`, async () => {
      state.locked = locked;

      await import("./index");
      await vi.waitUntil(() => state.events.includes("exit:0"));

      expect(state.events).toEqual(
        locked
          ? ["preflight", "lock", "layer", "runtime", "exit:0"]
          : ["preflight", "lock", "exit:0"],
      );
      expect(state.lockData).toEqual({ argv: process.argv });
    });
  }
});
