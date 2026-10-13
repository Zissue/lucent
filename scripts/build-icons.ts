import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { commandOutput } from "./process.mjs";
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
const DEV_ICON_SOURCE = join(REPO_ROOT, "assets", "icons", "lucent-dev.icon");
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

const resolveIctool = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const candidate of ICTOOL_CANDIDATES) {
    if (yield* fs.exists(candidate)) return candidate;
  }
  return yield* Effect.fail(
    new BuildIconsError(
      "Icon Composer ictool was not found. Install Icon Composer or set ICON_COMPOSER_ICTOOL.",
    ),
  );
});

const exportIconPng = (
  ictool: string,
  inputPath: string,
  outputPath: string,
  size: number,
) =>
  commandOutput(
    ictool,
    [
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
    ],
    { cwd: REPO_ROOT },
  );

const convertToSrgbPng = Effect.fn("convertToSrgbPng")(function* (
  inputPath: string,
  tempDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const outputPath = join(tempDir, "srgb.png");
  yield* commandOutput(
    "sips",
    ["--matchTo", SRGB_PROFILE_PATH, inputPath, "--out", outputPath],
    { cwd: REPO_ROOT },
  );
  yield* fs.rename(outputPath, inputPath);
});

const makeSingleImageIco = (png: Uint8Array): Buffer => {
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

const buildIcons = Effect.gen(function* () {
  if (process.platform !== "darwin")
    return yield* Effect.fail(
      new BuildIconsError("Icon generation requires macOS."),
    );
  const fs = yield* FileSystem.FileSystem;
  const ictool = yield* resolveIctool;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "lucent-icons-",
  });
  yield* fs.makeDirectory(ASSETS_DIR, { recursive: true });

  const productionPngPath = join(ASSETS_DIR, "icon.png");
  const devPngPath = join(ASSETS_DIR, "icon-dev.png");
  yield* exportIconPng(ictool, PRODUCTION_ICON_SOURCE, productionPngPath, 1024);
  yield* convertToSrgbPng(productionPngPath, tempDir);
  yield* exportIconPng(ictool, DEV_ICON_SOURCE, devPngPath, 1024);
  yield* convertToSrgbPng(devPngPath, tempDir);
  const icoPngPath = join(tempDir, "icon-256.png");
  yield* exportIconPng(ictool, PRODUCTION_ICON_SOURCE, icoPngPath, 256);
  yield* convertToSrgbPng(icoPngPath, tempDir);
  yield* fs.writeFile(
    join(ASSETS_DIR, "icon.ico"),
    makeSingleImageIco(yield* fs.readFile(icoPngPath)),
  );
});

buildIcons.pipe(
  Effect.scoped,
  Effect.catch((cause) =>
    Effect.sync(() => {
      console.error("Icon build failed:", cause);
      process.exitCode = 1;
    }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
