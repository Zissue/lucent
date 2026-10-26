import "../runtime/loop";
import "../runtime/web";

import { host, onInbound } from "../runtime/host";
import { makeDesktop } from "./desktop";

export interface AccountConfig {
  readonly debug: boolean;
  readonly os: "linux" | "mac" | "windows";
}

export const config = JSON.parse(
  String(host().call("config")),
) as AccountConfig;

const swfCall = (method: string, args: unknown[]): unknown => {
  const result = host().call("swf", method, JSON.stringify(args));
  return result === undefined ? undefined : JSON.parse(String(result));
};

const swf = new Proxy(
  {},
  {
    get: (_target, name) =>
      typeof name === "string"
        ? (...args: unknown[]) => swfCall(name, args)
        : undefined,
  },
);

onInbound<{ readonly name: string; readonly args?: readonly unknown[] }>(
  "loader",
  ({ name, args }) => {
    const callback: unknown = Reflect.get(globalThis, name);
    if (typeof callback === "function") {
      callback(...(args ?? []));
    }
  },
);

const emitConsole =
  (level: "debug" | "info" | "warn" | "error") =>
  (...values: unknown[]): void => {
    const text = values
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack ?? String(value);
        try {
          return JSON.stringify(value) ?? String(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");
    host().call("console", level, text);
  };

Object.assign(globalThis, {
  swf,
  console: {
    debug: emitConsole("debug"),
    trace: emitConsole("debug"),
    log: emitConsole("info"),
    info: emitConsole("info"),
    warn: emitConsole("warn"),
    error: emitConsole("error"),
  },
  desktop: makeDesktop(config),
});
