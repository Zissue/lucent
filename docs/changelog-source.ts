import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ContentSource, SourceEntry } from "blume/sources/types.ts";

const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const changelogPath = fileURLToPath(changelogUrl);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseHeading =
  /^# \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]\([^)\r\n]+\) - \((\d{4}-\d{2}-\d{2})\)[ \t]*$/gm;

const parseChangelog = (changelog: string): SourceEntry[] => {
  const headings = [...changelog.matchAll(releaseHeading)];
  const releaseHeadingCount = [...changelog.matchAll(/^# \[/gm)].length;
  if (headings.length === 0 || headings.length !== releaseHeadingCount) {
    throw new Error("CHANGELOG.md has a missing or malformed release heading.");
  }

  return headings.map((heading, index) => {
    const version = heading[1];
    const date = heading[2];
    const nextHeading = headings[index + 1];
    const body = changelog
      .slice(heading.index + heading[0].length, nextHeading?.index)
      .trim();
    if (!version || !date || !body) {
      throw new Error("CHANGELOG.md has a release without notes.");
    }

    const title = `v${version}`;
    const data = {
      changelog: { category: "Release", version },
      date,
      title,
      type: "changelog",
    };
    const raw = [
      "---",
      `title: ${JSON.stringify(title)}`,
      "type: changelog",
      `date: ${date}`,
      "changelog:",
      `  version: ${JSON.stringify(version)}`,
      "  category: Release",
      "---",
      "",
      body,
      "",
    ].join("\n");

    return {
      body: { format: "md", text: body },
      data,
      editUrl: `https://github.com/toommyliu/lucent/releases/tag/${title}`,
      lastModified: date,
      raw,
      ref: `${title.replaceAll(".", "-")}.md`,
    };
  });
};

export const changelogSource: ContentSource = {
  name: "changelog",
  prefix: "changelog",
  staged: true,
  load: async () => ({
    diagnostics: [],
    entries: parseChangelog(await readFile(changelogPath, "utf8")),
  }),
  read: async (ref) => {
    const entry = parseChangelog(await readFile(changelogPath, "utf8")).find(
      (candidate) => candidate.ref === ref,
    );
    if (!entry?.raw) {
      throw new Error(`Unknown changelog entry: ${ref}`);
    }
    return entry.raw;
  },
  watch: (onChange) => {
    const watcher = watch(repoRoot, (_event, filename) => {
      if (filename === null || filename === "CHANGELOG.md") onChange();
    });
    return () => watcher.close();
  },
};
