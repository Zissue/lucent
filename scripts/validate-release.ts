import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractReleaseNotesFromChangelog,
  validateReleaseInputs,
} from "./release-logic";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");

const main = async (): Promise<void> => {
  const tag = process.argv[2];
  if (!tag) {
    throw new Error("Usage: pnpm release:validate <tag> [notes-output-path]");
  }

  const [packageSource, changelog] = await Promise.all([
    readFile(join(REPO_ROOT, "app", "package.json"), "utf8"),
    readFile(join(REPO_ROOT, "CHANGELOG.md"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    readonly version?: unknown;
  };
  const validationError = validateReleaseInputs({
    packageVersion: packageJson.version,
    tag,
  });

  if (validationError !== null) {
    throw new Error(validationError);
  }

  const releaseNotes = extractReleaseNotesFromChangelog(changelog, tag);
  if (releaseNotes === null) {
    throw new Error(`CHANGELOG.md has no release notes for ${tag}.`);
  }

  const outputPath = process.argv[3];
  if (outputPath) {
    await writeFile(outputPath, releaseNotes);
  }

  console.log(`Validated release ${tag}.`);
};

main().catch((cause: unknown) => {
  console.error("Release validation failed:", cause);
  process.exitCode = 1;
});
