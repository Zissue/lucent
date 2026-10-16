import { spawnSync } from "node:child_process";
import { describe, expect, it } from "@effect/vitest";

import {
  extractReleaseNotesFromChangelog,
  findLatestRelease,
  formatReleaseTag,
  gitCliffChangelogArgs,
  gitCliffChangelogCommand,
  makeInitialChangelog,
  RELEASE_NOTES_PLACEHOLDER_CONTENT,
  releaseNotesAreReady,
  resolveTargetVersion,
  validateReleaseInputs,
} from "./release-logic";

describe("release logic", () => {
  it("requires an explicit version for the first release", () => {
    expect(resolveTargetVersion("patch", null)).toEqual({
      ok: false,
      message: "The first release requires an explicit version like 0.0.1.",
    });
    expect(resolveTargetVersion("0.0.1", null)).toEqual({
      ok: true,
      version: "0.0.1",
    });
  });

  it("uses v-prefixed tags for later releases", () => {
    const latestRelease = findLatestRelease([
      "nightly",
      "0.0.2",
      "v0.0.1-beta.1",
      "v0.0.1+build.1",
      "vv0.0.1",
      "v01.0.1",
      "v0.0.1 ",
      "v0.0.1",
    ]);

    expect(latestRelease).toEqual({ tag: "v0.0.1", version: "0.0.1" });
    expect(resolveTargetVersion("patch", latestRelease)).toEqual({
      ok: true,
      version: "0.0.2",
    });
    expect(formatReleaseTag("0.0.2")).toBe("v0.0.2");
  });

  it("bumps each component without changing the latest release", () => {
    const latestRelease = findLatestRelease(["v1.2.3"]);
    for (const [bump, version] of [
      ["patch", "1.2.4"],
      ["minor", "1.3.0"],
      ["major", "2.0.0"],
      ["patch", "1.2.4"],
    ] as const) {
      expect(resolveTargetVersion(bump, latestRelease)).toEqual({
        ok: true,
        version,
      });
    }
  });

  it.each([
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3+build.1",
    "01.2.3",
    "1.2",
    "9007199254740992.0.0",
  ])("rejects noncanonical or invalid versions: %s", (version) => {
    expect(resolveTargetVersion(version, null).ok).toBe(false);
    expect(
      validateReleaseInputs({ packageVersion: version, tag: `v${version}` }),
    ).toBe("app/package.json must contain a semantic version.");
  });

  it.each([
    ["1.2.9", false],
    ["1.2.10", false],
    ["1.2.11", true],
    ["1.3.0", true],
    ["2.0.0", true],
    ["1.1.99", false],
    ["0.99.99", false],
  ])("compares %s numerically against the latest release", (version, ok) => {
    const result = resolveTargetVersion(
      version,
      findLatestRelease(["v1.2.10"]),
    );
    expect(result.ok).toBe(ok);
    if (ok) {
      expect(result).toEqual({ ok: true, version });
    }
  });

  it("orders prerelease tags by semver precedence", () => {
    expect(
      findLatestRelease([
        "v0.0.2",
        "v0.1.0-beta.10",
        "v0.1.0-beta.9",
        "v0.1.0-alpha.20",
      ]),
    ).toEqual({ tag: "v0.1.0-beta.10", version: "0.1.0-beta.10" });
    expect(findLatestRelease(["v0.1.0-beta.2", "v0.1.0", "v0.0.2"])).toEqual({
      tag: "v0.1.0",
      version: "0.1.0",
    });
  });

  it("starts, continues, and graduates a prerelease series", () => {
    const stable = { tag: "v0.0.2", version: "0.0.2" };
    const beta = { tag: "v0.1.0-beta.2", version: "0.1.0-beta.2" };

    expect(resolveTargetVersion("0.1.0-beta.1", stable)).toEqual({
      ok: true,
      version: "0.1.0-beta.1",
    });
    expect(resolveTargetVersion("prerelease", beta)).toEqual({
      ok: true,
      version: "0.1.0-beta.3",
    });
    expect(resolveTargetVersion("minor", beta)).toEqual({
      ok: true,
      version: "0.1.0",
    });
    expect(resolveTargetVersion("0.1.0", beta)).toEqual({
      ok: true,
      version: "0.1.0",
    });
  });

  it("rejects prerelease targets that do not move forward", () => {
    expect(
      resolveTargetVersion("prerelease", { tag: "v0.0.2", version: "0.0.2" }),
    ).toEqual({
      ok: false,
      message:
        "Latest release v0.0.2 is stable. Start a prerelease series with an explicit version like 0.1.0-beta.1.",
    });
    expect(
      resolveTargetVersion("0.1.0-beta.1", {
        tag: "v0.1.0-beta.2",
        version: "0.1.0-beta.2",
      }),
    ).toEqual({
      ok: false,
      message:
        "Target version 0.1.0-beta.1 must be greater than latest release v0.1.0-beta.2.",
    });
    expect(
      resolveTargetVersion("0.1.0-beta.1", { tag: "v0.1.0", version: "0.1.0" }),
    ).toEqual({
      ok: false,
      message:
        "Target version 0.1.0-beta.1 must be greater than latest release v0.1.0.",
    });
  });

  it("preserves the release tag, date, and curated notes in the initial changelog", () => {
    const notes = "## Highlights\n\nInitial release notes.\n";
    const changelog = makeInitialChangelog({ date: "2026-08-31", notes, tag: "v0.0.1", version: "0.0.1" });
    expect(changelog).toContain("https://github.com/toommyliu/lucent/tree/v0.0.1");
    expect(changelog).toContain("2026-08-31");
    expect(extractReleaseNotesFromChangelog(changelog, "v0.0.1")).toBe(notes);
    expect(extractReleaseNotesFromChangelog(changelog, "v0.0.2")).toBeNull();
  });

  it("requires the first release notes placeholder to be replaced", () => {
    expect(releaseNotesAreReady(RELEASE_NOTES_PLACEHOLDER_CONTENT)).toBe(false);
    expect(releaseNotesAreReady("## Highlights\n\nReady.")).toBe(true);
  });

  it("generates only unreleased changes for later releases", () => {
    expect(gitCliffChangelogArgs("v0.0.2")).toEqual([
      "--config",
      "cliff.toml",
      "--unreleased",
      "--tag",
      "v0.0.2",
      "--prepend",
      "CHANGELOG.md",
    ]);
  });

  it("scopes prerelease changelogs to changes since the previous tag", () => {
    expect(gitCliffChangelogArgs("v0.1.0-beta.2")).toEqual([
      "--config",
      "cliff.toml",
      "--unreleased",
      "--tag",
      "v0.1.0-beta.2",
      "--tag-pattern",
      String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`,
      "--prepend",
      "CHANGELOG.md",
    ]);
  });

  it.skipIf(process.platform === "win32").each([
    "sh",
    "bash",
    ...(process.platform === "darwin" ? ["zsh"] : []),
  ])("preserves the dry-run tag pattern when copied into %s", (shell) => {
    const result = spawnSync(
      shell,
      [
        "-c",
        `set -- ${gitCliffChangelogCommand("v0.1.0-beta.2")}\nshift\nprintf '%s\\n' "$@"`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "--config",
      "cliff.toml",
      "--unreleased",
      "--tag",
      "v0.1.0-beta.2",
      "--tag-pattern",
      String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`,
      "--prepend",
      "CHANGELOG.md",
    ]);
  });

  it("accepts prerelease app versions with matching tags", () => {
    expect(
      validateReleaseInputs({
        packageVersion: "0.1.0-beta.1",
        tag: "v0.1.0-beta.1",
      }),
    ).toBeNull();
  });

  it("rejects mismatched tags", () => {
    expect(
      validateReleaseInputs({
        packageVersion: "0.0.1",
        tag: "0.0.1",
      }),
    ).toBe(
      "Release tag 0.0.1 does not match app version 0.0.1. Expected v0.0.1.",
    );
  });

  it("extracts one release body from the changelog", () => {
    const changelog =
      "# Changelog\n\n" +
      "# [0.0.2](https://example.com/v0.0.2) - (2026-08-31)\n\n" +
      "## Features\n\n- A later feature\n\n" +
      "# [0.0.1](https://example.com/v0.0.1) - (2026-08-30)\n\n" +
      "## Highlights\n\nInitial release.\n";

    expect(extractReleaseNotesFromChangelog(changelog, "v0.0.2")).toBe(
      "## Features\n\n- A later feature\n",
    );
    expect(extractReleaseNotesFromChangelog(changelog, "v0.0.3")).toBeNull();
  });

  it("extracts prerelease notes without matching the stable heading", () => {
    const changelog =
      "# Changelog\n\n" +
      "# [0.1.0](https://example.com/v0.1.0) - (2026-10-02)\n\n" +
      "## Features\n\n- Stable feature\n\n" +
      "# [0.1.0-beta.1](https://example.com/v0.1.0-beta.1) - (2026-10-01)\n\n" +
      "## Features\n\n- Beta feature\n";

    expect(extractReleaseNotesFromChangelog(changelog, "v0.1.0-beta.1")).toBe(
      "## Features\n\n- Beta feature\n",
    );
    expect(extractReleaseNotesFromChangelog(changelog, "v0.1.0")).toBe(
      "## Features\n\n- Stable feature\n",
    );
  });
});
