import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const state = vi.hoisted(() => ({
  locked: false,
  events: [] as string[],
}));

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => {
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
  makeDesktopLayer: () => {
    state.events.push("layer");
    return {};
  },
}));
vi.mock("./app/DesktopRuntime", () => ({
  makeDesktopRuntime: () => {
    state.events.push("runtime");
    return Effect.void;
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.events.length = 0;
});

describe("main process single-instance lock", () => {
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
    });
  }
});
