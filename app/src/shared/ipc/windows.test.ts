import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DesktopRendererKindSchema, WindowsIpc } from "./windows";

describe("WindowsIpc.open", () => {
  it.effect.each([
    "about",
    "account-manager",
    "combat-profiles",
    "environment",
    "follower",
    "game",
    "loader-grabber",
    "packets",
    "settings",
  ])("accepts the %s window kind", (kind) =>
    Effect.gen(function* () {
      const payload: unknown = { kind };
      expect(yield* WindowsIpc.open.decodePayloadEffect(payload)).toEqual({
        kind,
      });
    }),
  );

  it.effect("rejects renderer-only kinds and unknown window kinds", () =>
    Effect.gen(function* () {
      expect(
        yield* WindowsIpc.open.decodePayloadEffect({ kind: "game" }),
      ).toEqual({ kind: "game" });
      for (const kind of ["game-group-controls", "game-host", "unknown"]) {
        const error = yield* Effect.flip(
          WindowsIpc.open.decodePayloadEffect({ kind }),
        );
        expect(error._tag).toBe("SchemaError");
      }
    }),
  );
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
