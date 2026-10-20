import { describe, expect, it } from "@effect/vitest";

import { desktopLogErrorDetails } from "../../shared/logRecord";
import { parseLocalJson } from "./parseLocalJson";

describe("parseLocalJson", () => {
  it("parses JSON values", () => {
    expect(parseLocalJson('{"enabled":true,"values":[1,null,"text"]}')).toEqual(
      {
        enabled: true,
        values: [1, null, "text"],
      },
    );
    expect(parseLocalJson("null")).toBeNull();
  });

  it("retains only the line and column from positioned parse failures", () => {
    expect(() =>
      parseLocalJson('{\n  "password": "hunter2-secret-token",\n}'),
    ).toThrowError(new SyntaxError("Invalid JSON at line 3 column 1"));
  });

  it("replaces source excerpts with a fresh error safe to log", () => {
    let failure: unknown;
    try {
      parseLocalJson('{"password": hunter2-secret-token}');
    } catch (cause) {
      failure = cause;
    }

    const logged = desktopLogErrorDetails(failure);
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(logged).toMatchObject({
      name: "SyntaxError",
      message: "Invalid JSON",
    });
    expect(JSON.stringify(logged)).not.toContain("hunter2");
    expect(failure).not.toHaveProperty("cause");
    expect(logged.cause).toBeUndefined();
  });

  it("uses the fixed fallback when there is no location", () => {
    expect(() => parseLocalJson("")).toThrowError(
      new SyntaxError("Invalid JSON"),
    );
  });

  it("does not treat a location embedded in file text as a diagnostic", () => {
    expect(() => parseLocalJson("line 9 column 99")).toThrowError(
      new SyntaxError("Invalid JSON"),
    );
  });
});
