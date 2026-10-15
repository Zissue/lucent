import { describe, expect, it } from "vitest";

import { parseCliOptions } from "./cli";

describe("parseCliOptions", () => {
  it.each([
    ["--launch-mode", "game"],
    ["--launch-mode=game"],
    ["--launchMode", "game"],
    ["--launchMode=game"],
  ])("accepts launch-mode arguments %j", (...args) => {
    expect(parseCliOptions(args)).toEqual({ launchMode: "game" });
  });

  it("normalizes the manager shorthand and accepts the canonical mode", () => {
    expect(parseCliOptions(["--launch-mode", " MANAGER "])).toEqual({
      launchMode: "account-manager",
    });
    expect(parseCliOptions(["--launch-mode=account-manager"])).toEqual({
      launchMode: "account-manager",
    });
  });

  it("uses the last valid launch mode across both aliases", () => {
    expect(
      parseCliOptions([
        "--launch-mode",
        "game",
        "--launchMode=manager",
        "--launch-mode=unknown",
      ]),
    ).toEqual({ launchMode: "account-manager" });
  });

  it("ignores Electron arguments while enabling requested diagnostics", () => {
    expect(
      parseCliOptions([
        "/Applications/Lucent.app/Contents/MacOS/Lucent",
        "--inspect=9229",
        "--original-process-start-time=123",
        "-psn_0_42",
        "--debug",
        "--launch-mode=game",
      ]),
    ).toEqual({ debug: true, launchMode: "game" });
  });

  it("ignores missing and invalid values without consuming the next flag", () => {
    expect(parseCliOptions(["--launch-mode", "--debug"])).toEqual({
      debug: true,
    });
    expect(parseCliOptions(["--launch-mode"])).toEqual({});
    expect(parseCliOptions(["--launchMode=invalid", "--launch-mode="])).toEqual(
      {},
    );
    expect(parseCliOptions(["--debug=false"])).toEqual({});
  });

  it("stops parsing options after the argument terminator", () => {
    expect(
      parseCliOptions([
        "--launch-mode=game",
        "--",
        "--debug",
        "--launch-mode=manager",
      ]),
    ).toEqual({ launchMode: "game" });
  });
});
