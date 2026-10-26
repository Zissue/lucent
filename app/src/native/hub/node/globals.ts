import { Buffer } from "./buffer";

if (Reflect.get(globalThis, "Buffer") === undefined) {
  Object.assign(globalThis, { Buffer });
}

if (Reflect.get(globalThis, "process") === undefined) {
  Object.assign(globalThis, {
    process: {
      pid: 1,
      platform: "darwin",
      arch: "arm64",
      env: {},
      argv: [],
      versions: {},
      cwd: () => "/",
      emitWarning: (warning: unknown) => console.warn(String(warning)),
      nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
        queueMicrotask(() => fn(...args)),
    },
  });
}
