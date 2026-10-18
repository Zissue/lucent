import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DesktopRendererKindSchema, WindowsIpc } from "./windows";

describe("WindowsIpc.open", () => {
  it.each([
    "about",
    "account-manager",
    "combat-profiles",
    "environment",
    "follower",
    "game",
    "loader-grabber",
    "packets",
    "settings",
  ])("accepts the %s window kind", (kind) => {
    const payload: unknown = { kind };

    expect(Schema.decodeUnknownSync(WindowsIpc.open.payload)(payload)).toEqual({
      kind,
    });
  });

  it("rejects renderer-only kinds and unknown window kinds", () => {
    const decode = Schema.decodeUnknownSync(WindowsIpc.open.payload);

    expect(decode({ kind: "game" })).toEqual({ kind: "game" });
    expect(() => decode({ kind: "game-group-controls" })).toThrow();
    expect(() => decode({ kind: "game-host" })).toThrow();
    expect(() => decode({ kind: "unknown" })).toThrow();
  });
});

describe("DesktopRendererKindSchema", () => {
  it("accepts window kinds and renderer-only kinds while rejecting unknown kinds", () => {
    const decode = Schema.decodeUnknownSync(DesktopRendererKindSchema);

    expect(decode("game")).toBe("game");
    expect(decode("settings")).toBe("settings");
    expect(decode("game-group-controls")).toBe("game-group-controls");
    expect(decode("game-host")).toBe("game-host");
    expect(() => decode("unknown")).toThrow();
    expect(() => decode(42)).toThrow();
  });
});
