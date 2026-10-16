import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AccountLaunchRequestSchema,
  normalizeAccountManagerStorage,
  renameGroupMemberUsername,
  removeGroupMemberUsername,
  serializeAccountManagerStorage,
} from "./accounts";

const isAccountLaunchRequest = Schema.is(AccountLaunchRequestSchema);

describe("account manager storage", () => {
  it("normalizes existing account JSON while preserving the saved shape", () => {
    const normalized = normalizeAccountManagerStorage({
      accounts: [
        { label: "Main", username: "Hero", password: "secret" },
        { label: "Duplicate", username: "hero", password: "ignored" },
        { label: "Alt", username: "Alt", password: "alt-secret" },
        { label: "Broken", username: "NoPassword" },
      ],
      groups: {
        Farmers: ["Hero", "Alt", "Missing", "Hero"],
        " ": ["Hero"],
      },
    });

    expect(normalized).toEqual({
      accounts: [
        { label: "Main", username: "Hero", password: "secret" },
        { label: "Alt", username: "Alt", password: "alt-secret" },
      ],
      groups: {
        Farmers: ["Hero", "Alt"],
      },
    });

    expect(serializeAccountManagerStorage(normalized)).toEqual(normalized);
  });

  it("keeps group membership aligned with account renames and deletes", () => {
    const groups = {
      Farmers: ["Hero", "Alt"],
      Solo: ["Hero"],
    };

    expect(renameGroupMemberUsername(groups, "Hero", "Main")).toEqual({
      Farmers: ["Main", "Alt"],
      Solo: ["Main"],
    });
    expect(removeGroupMemberUsername(groups, "Hero")).toEqual({
      Farmers: ["Alt"],
      Solo: [],
    });
  });
});

describe("account launch request", () => {
  it("accepts path-only script references", () => {
    expect(
      isAccountLaunchRequest({
        username: "Hero",
        script: { name: "farm.js", path: "/scripts/farm.js" },
      }),
    ).toBe(true);
    expect(
      isAccountLaunchRequest({
        username: "Hero",
        script: { name: "farm.js" },
      }),
    ).toBe(false);
  });
});
