import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const ASSETS_DIR = join(REPO_ROOT, "assets");
const PRODUCTION_ICON_SOURCE = join(
  REPO_ROOT,
  "assets",
  "icons",
  "lucent.icon",
);
const DEV_ICON_SOURCE = join(
  REPO_ROOT,
  "assets",
  "icons",
  "lucent-dev.icon",
);
const SRGB_PROFILE_PATH = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";

class BuildIconsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuildIconsError";
  }
}

const ICTOOL_CANDIDATES = [
  process.env["ICON_COMPOSER_ICTOOL"],
  "/Applications/Icon Composer.app/Contents/Executables/ictool",
  "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool",
].filter((value): value is string => Boolean(value));

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const resolveIctool = async (): Promise<string> => {
  for (const candidate of ICTOOL_CANDIDATES) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new BuildIconsError(
    "Icon Composer ictool was not found. Install Icon Composer or set ICON_COMPOSER_ICTOOL.",
  );
};

const formatCommand = (
  command: string,
  args: ReadonlyArray<string>,
): string =>
  [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");

const run = (
  command: string,
  args: ReadonlyArray<string>,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", (cause) => {
      reject(
        new BuildIconsError(
          `${formatCommand(command, args)} failed to start: ${cause.message}`,
          { cause },
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const details = Buffer.concat(output).toString("utf8").trim();
      const reason =
        signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      reject(
        new BuildIconsError(
          `${formatCommand(command, args)} failed with ${reason}${details ? `:\n${details}` : ""}`,
        ),
      );
    });
  });

const exportIconPng = async (
  ictool: string,
  inputPath: string,
  outputPath: string,
  size: number,
): Promise<void> => {
  await run(ictool, [
    inputPath,
    "--export-image",
    "--output-file",
    outputPath,
    "--platform",
    "macOS",
    "--rendition",
    "Default",
    "--width",
    String(size),
    "--height",
    String(size),
    "--scale",
    "1",
  ]);
};

const convertToSrgbPng = async (
  inputPath: string,
  tempDir: string,
): Promise<void> => {
  const outputPath = join(tempDir, `srgb-${Date.now()}-${Math.random()}.png`);
  await run("sips", ["--matchTo", SRGB_PROFILE_PATH, inputPath, "--out", outputPath]);
  await rename(outputPath, inputPath);
};

const makeSingleImageIco = (png: Buffer): Buffer => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
};

const buildIcons = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    throw new BuildIconsError("Icon generation requires macOS.");
  }

  const ictool = await resolveIctool();
  const tempDir = await mkdtemp(join(tmpdir(), "lucent-icons-"));

  try {
    await mkdir(ASSETS_DIR, { recursive: true });

    const productionPngPath = join(ASSETS_DIR, "icon.png");
    const devPngPath = join(ASSETS_DIR, "icon-dev.png");

    await exportIconPng(
      ictool,
      PRODUCTION_ICON_SOURCE,
      productionPngPath,
      1024,
    );
    await convertToSrgbPng(productionPngPath, tempDir);

    await exportIconPng(ictool, DEV_ICON_SOURCE, devPngPath, 1024);
    await convertToSrgbPng(devPngPath, tempDir);

    const icoPngPath = join(tempDir, "icon-256.png");
    await exportIconPng(ictool, PRODUCTION_ICON_SOURCE, icoPngPath, 256);
    await convertToSrgbPng(icoPngPath, tempDir);
    await writeFile(
      join(ASSETS_DIR, "icon.ico"),
      makeSingleImageIco(await readFile(icoPngPath)),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

buildIcons().catch((cause) => {
  console.error("Icon build failed:", cause);
  process.exitCode = 1;
});
