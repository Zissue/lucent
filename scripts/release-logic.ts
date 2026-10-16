import { compare, prerelease, SemVer, valid } from "semver";

export const RELEASE_NOTES_PLACEHOLDER = "<!-- release-notes-placeholder -->";
export const RELEASE_NOTES_PLACEHOLDER_CONTENT = `${RELEASE_NOTES_PLACEHOLDER}

Write the v0.0.1 release notes here before preparing the release.
`;

const RELEASE_OR_PRERELEASE_TAG_PATTERN = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`;

export const BUMP_KINDS = ["patch", "minor", "major", "prerelease"] as const;

export type BumpKind = (typeof BUMP_KINDS)[number];

export type Release = {
  readonly tag: string;
  readonly version: string;
};

export type TargetVersionResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

export const isBumpKind = (value: string): value is BumpKind =>
  BUMP_KINDS.includes(value as BumpKind);

export const parseVersion = (value: string): string | null =>
  valid(value) === value ? value : null;

export const parseReleaseTag = (tag: string): string | null =>
  tag.startsWith("v") ? parseVersion(tag.slice(1)) : null;

export const formatReleaseTag = (version: string): string => `v${version}`;

export const findLatestRelease = (
  tags: ReadonlyArray<string>,
): Release | null => {
  let latest: Release | null = null;
  for (const tag of tags) {
    const version = parseReleaseTag(tag);
    if (
      version !== null &&
      (latest === null || compare(version, latest.version) > 0)
    ) {
      latest = { tag, version };
    }
  }

  return latest;
};

export const resolveTargetVersion = (
  bumpOrVersion: string,
  latestRelease: Release | null,
): TargetVersionResult => {
  if (isBumpKind(bumpOrVersion)) {
    if (latestRelease === null) {
      return {
        ok: false,
        message: "The first release requires an explicit version like 0.0.1.",
      };
    }

    if (
      bumpOrVersion === "prerelease" &&
      prerelease(latestRelease.version) === null
    ) {
      return {
        ok: false,
        message: `Latest release ${latestRelease.tag} is stable. Start a prerelease series with an explicit version like 0.1.0-beta.1.`,
      };
    }

    return {
      ok: true,
      version: new SemVer(latestRelease.version).inc(bumpOrVersion).version,
    };
  }

  const version = parseVersion(bumpOrVersion);
  if (version === null) {
    return {
      ok: false,
      message:
        "Release version must be patch, minor, major, prerelease, or a version like 0.9.0 or 0.9.0-beta.1.",
    };
  }

  if (latestRelease !== null && compare(version, latestRelease.version) <= 0) {
    return {
      ok: false,
      message: `Target version ${version} must be greater than latest release ${latestRelease.tag}.`,
    };
  }

  return { ok: true, version };
};

export const releaseNotesAreReady = (source: string): boolean =>
  source.trim().length > 0 && !source.includes(RELEASE_NOTES_PLACEHOLDER);

export const makeInitialChangelog = (options: {
  readonly date: string;
  readonly notes: string;
  readonly tag: string;
  readonly version: string;
}): string =>
  [
    "# Changelog",
    "",
    "All notable changes to this project will be documented in this file.",
    "",
    `# [${options.version}](https://github.com/toommyliu/lucent/tree/${options.tag}) - (${options.date})`,
    options.notes.trim(),
    "",
  ].join("\n");

// cliff.toml matches only stable tags, so stable notes cover every prerelease
// since the last stable release. Prerelease notes start at the previous tag.
export const gitCliffChangelogArgs = (tag: string): ReadonlyArray<string> => [
  "--config",
  "cliff.toml",
  "--unreleased",
  "--tag",
  tag,
  ...(prerelease(tag) === null
    ? []
    : ["--tag-pattern", RELEASE_OR_PRERELEASE_TAG_PATTERN]),
  "--prepend",
  "CHANGELOG.md",
];

export const gitCliffChangelogCommand = (tag: string): string =>
  `git-cliff ${gitCliffChangelogArgs(tag)
    .map((arg) =>
      arg === RELEASE_OR_PRERELEASE_TAG_PATTERN ? `"${arg}"` : arg,
    )
    .join(" ")}`;

export const validateReleaseInputs = (options: {
  readonly packageVersion: unknown;
  readonly tag: string;
}): string | null => {
  if (
    typeof options.packageVersion !== "string" ||
    parseVersion(options.packageVersion) === null
  ) {
    return "app/package.json must contain a semantic version.";
  }

  const expectedTag = formatReleaseTag(options.packageVersion);
  if (options.tag !== expectedTag) {
    return `Release tag ${options.tag} does not match app version ${options.packageVersion}. Expected ${expectedTag}.`;
  }

  return null;
};

export const extractReleaseNotesFromChangelog = (
  changelog: string,
  tag: string,
): string | null => {
  const expectedVersion = parseReleaseTag(tag);
  if (expectedVersion === null) {
    return null;
  }

  const headingPattern =
    /^# \[([^\]]+)\]\([^\r\n]+\) - \(\d{4}-\d{2}-\d{2}\)\s*$/gm;
  const headings = [...changelog.matchAll(headingPattern)];
  const headingIndex = headings.findIndex(
    (match) => match[1] === expectedVersion,
  );
  const heading = headings[headingIndex];
  if (headingIndex === -1 || heading?.index === undefined) {
    return null;
  }

  const nextHeading = headings[headingIndex + 1];
  const start = heading.index + heading[0].length;
  const end = nextHeading?.index ?? changelog.length;
  const notes = changelog.slice(start, end).trim();

  return notes.length > 0 ? `${notes}\n` : null;
};
