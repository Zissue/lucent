import { describe, expect, it } from "@effect/vitest";

import {
  findDuplicateHotkeyBinding,
  formatHotkeyDisplay,
  formatHotkeyDisplayParts,
  hotkeyBindingMatchKey,
  normalizeHotkeyBindingValue,
} from "./hotkeys";

describe("hotkeys", () => {
  it("formats normalized hotkeys for platform display", () => {
    expect(formatHotkeyDisplay("", "mac")).toBe("Unbound");
    expect(formatHotkeyDisplay("Mod+Shift+X", "mac")).toBe("⌘ ⇧ X");
    expect(formatHotkeyDisplayParts("Mod+Shift+X", "mac")).toEqual([
      "⌘",
      "⇧",
      "X",
    ]);
    expect(formatHotkeyDisplay("Mod+Shift+X", "windows")).toBe("Ctrl+Shift+X");
    expect(formatHotkeyDisplay("Control+Shift+ArrowDown", "windows")).toBe(
      "Ctrl+Shift+↓",
    );
    expect(formatHotkeyDisplay("Alt+ArrowLeft", "mac")).toBe("⌥ ←");
  });

  it("resolves Mod to the platform modifier for matching", () => {
    expect(hotkeyBindingMatchKey("Mod+O", "windows")).toBe(
      hotkeyBindingMatchKey("Control+O", "windows"),
    );
    expect(hotkeyBindingMatchKey("Mod+O", "linux")).toBe(
      hotkeyBindingMatchKey("Control+O", "linux"),
    );
    expect(hotkeyBindingMatchKey("Mod+O", "mac")).toBe(
      hotkeyBindingMatchKey("Meta+O", "mac"),
    );
    expect(hotkeyBindingMatchKey("Mod+Shift+T", "mac")).toBe(
      hotkeyBindingMatchKey("Shift+Meta+T", "mac"),
    );
  });

  it("rejects invalid hotkey values", () => {
    expect(normalizeHotkeyBindingValue("")).toBe("");
    expect(normalizeHotkeyBindingValue("Control+Control+X")).toBeNull();
    expect(normalizeHotkeyBindingValue("Control+Shift")).toBeNull();
    expect(normalizeHotkeyBindingValue("A+B")).toBeNull();
  });

  it("finds duplicate normalized bindings", () => {
    expect(
      findDuplicateHotkeyBinding([
        { id: "loadScript", value: "Control+O" },
        { id: "toggleScript", value: "Shift+X" },
        { id: "toggleTopBar", value: "Ctrl+O" },
      ]),
    ).toEqual({ id: "toggleTopBar", value: "Ctrl+O" });
  });
});
