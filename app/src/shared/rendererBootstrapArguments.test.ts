import { describe, expect, it } from "vitest";

import {
  readDesktopViewArgument,
  serializeDesktopViewArgument,
} from "./rendererBootstrapArguments";

describe("desktop view arguments", () => {
  it.each([
    "about",
    "account-manager",
    "combat-profiles",
    "environment",
    "follower",
    "game",
    "game-group-controls",
    "game-host",
    "loader-grabber",
    "packets",
    "settings",
  ] as const)("serializes and reads the %s view", (view) => {
    const argument = serializeDesktopViewArgument(view);

    expect(argument).toBe(`--lucent__view=${view}`);
    expect(readDesktopViewArgument(["app", argument])).toBe(view);
  });

  it.each([
    [],
    ["--lucent__view"],
    ["--lucent__view="],
    ["--lucent__view=unknown"],
    ["--other=game"],
  ])("rejects a missing or invalid view in %j", (...argv) => {
    expect(readDesktopViewArgument(argv)).toBeNull();
  });

  it("reads the first view argument", () => {
    expect(
      readDesktopViewArgument([
        "--lucent__view=game-host",
        "--lucent__view=game",
      ]),
    ).toBe("game-host");
  });
});
