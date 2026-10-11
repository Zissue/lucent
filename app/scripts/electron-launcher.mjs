import { spawnSync } from "child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const LAUNCHER_VERSION = 3;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(__dirname, "..");

const appBranding = JSON.parse(
  readFileSync(join(appDir, "appBranding.json"), "utf8"),
);
const repoRoot = resolve(appDir, "..");
const runtimeDir = join(appDir, ".electron-runtime");
const devIconComposerPath = join(
  repoRoot,
  "assets",
  "icons",
  "lucent-dev.icon",
);
const devIconPngPath = join(repoRoot, "assets", appBranding.dev.iconPng);
const fallbackIconPngPath = join(
  repoRoot,
  "assets",
  appBranding.production.iconPng,
);

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n");
  throw new Error(
    `Failed to run ${command} ${args.join(" ")}: ${details}`.trim(),
    { cause: result.error },
  );
}

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [
    insertResult.error?.message,
    replaceResult.stderr,
    insertResult.stderr,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(
    `Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim(),
    { cause: insertResult.error },
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function getMissingMacAppBundlePath(appBundlePath) {
  const requiredPaths = [
    join(appBundlePath, "Contents", "Info.plist"),
    join(appBundlePath, "Contents", "Resources"),
    join(appBundlePath, "Contents", "Frameworks"),
    join(appBundlePath, "Contents", "MacOS", "Electron"),
  ];

  return requiredPaths.find((requiredPath) => !existsSync(requiredPath));
}

function assertCompleteMacAppBundle(appBundlePath, context) {
  const missingPath = getMissingMacAppBundlePath(appBundlePath);
  if (!missingPath) {
    return;
  }

  throw new Error(
    [
      `${context} Electron app bundle is incomplete at ${appBundlePath}.`,
      `Missing required path: ${missingPath}.`,
      "Remove packages/electron/dist and packages/electron/path.txt, then run pnpm install again.",
    ].join(" "),
  );
}

function resolveDevIconPngPath() {
  if (existsSync(devIconPngPath)) {
    return devIconPngPath;
  }

  if (existsSync(fallbackIconPngPath)) {
    return fallbackIconPngPath;
  }

  return null;
}

function resolveDefaultIconPath(sourceAppBundlePath) {
  return join(sourceAppBundlePath, "Contents", "Resources", "electron.icns");
}

function getTreeMtimeMs(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let mtimeMs = stats.mtimeMs;
  for (const entry of readdirSync(path)) {
    mtimeMs = Math.max(mtimeMs, getTreeMtimeMs(join(path, entry)));
  }

  return mtimeMs;
}

function compileIconComposerAssets() {
  if (!existsSync(devIconComposerPath)) {
    return null;
  }

  const generatedRoot = join(runtimeDir, "icon-dev-composer");
  const generatedIconPath = join(generatedRoot, "icon.icns");
  const generatedAssetCatalogPath = join(generatedRoot, "Assets.car");
  const sourceMtimeMs = getTreeMtimeMs(devIconComposerPath);
  mkdirSync(runtimeDir, { recursive: true });

  if (
    existsSync(generatedIconPath) &&
    existsSync(generatedAssetCatalogPath) &&
    statSync(generatedIconPath).mtimeMs >= sourceMtimeMs &&
    statSync(generatedAssetCatalogPath).mtimeMs >= sourceMtimeMs
  ) {
    return {
      kind: "icon-composer",
      iconPath: generatedIconPath,
      assetCatalogPath: generatedAssetCatalogPath,
      sourcePath: devIconComposerPath,
      sourceMtimeMs,
    };
  }

  const compileRoot = mkdtempSync(join(runtimeDir, "dev-icon-composer-"));
  const inputPath = join(compileRoot, "Icon.icon");
  const outputPath = join(compileRoot, "out");
  mkdirSync(outputPath, { recursive: true });

  try {
    cpSync(devIconComposerPath, inputPath, { recursive: true });
    runChecked("actool", [
      inputPath,
      "--compile",
      outputPath,
      "--output-format",
      "human-readable-text",
      "--notices",
      "--warnings",
      "--output-partial-info-plist",
      join(outputPath, "assetcatalog_generated_info.plist"),
      "--app-icon",
      "Icon",
      "--include-all-app-icons",
      "--accent-color",
      "AccentColor",
      "--enable-on-demand-resources",
      "NO",
      "--development-region",
      "en",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "26.0",
      "--platform",
      "macosx",
    ]);

    mkdirSync(generatedRoot, { recursive: true });
    copyFileSync(join(outputPath, "Icon.icns"), generatedIconPath);
    copyFileSync(join(outputPath, "Assets.car"), generatedAssetCatalogPath);

    return {
      kind: "icon-composer",
      iconPath: generatedIconPath,
      assetCatalogPath: generatedAssetCatalogPath,
      sourcePath: devIconComposerPath,
      sourceMtimeMs,
    };
  } catch (error) {
    console.warn(
      "[electron-launcher] Failed to compile dev Icon Composer assets, falling back to static icon.",
      error,
    );
    return null;
  } finally {
    rmSync(compileRoot, { recursive: true, force: true });
  }
}

function ensureDevelopmentIconIcns(sourceAppBundlePath) {
  const sourceIconPath = resolveDevIconPngPath();
  const defaultIconPath = resolveDefaultIconPath(sourceAppBundlePath);

  if (!sourceIconPath) {
    return defaultIconPath;
  }

  const generatedIconPath = join(runtimeDir, "icon-dev.icns");
  mkdirSync(runtimeDir, { recursive: true });

  const sourceMtimeMs = statSync(sourceIconPath).mtimeMs;
  if (
    existsSync(generatedIconPath) &&
    statSync(generatedIconPath).mtimeMs >= sourceMtimeMs
  ) {
    return generatedIconPath;
  }

  const iconsetRoot = mkdtempSync(join(runtimeDir, "dev-iconset-"));
  const iconsetDir = join(iconsetRoot, "icon.iconset");
  mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const size of [16, 32, 128, 256, 512]) {
      runChecked("sips", [
        "-z",
        String(size),
        String(size),
        sourceIconPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}.png`),
      ]);

      const retinaSize = size * 2;
      runChecked("sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        sourceIconPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }

    runChecked("iconutil", ["-c", "icns", iconsetDir, "-o", generatedIconPath]);
    return generatedIconPath;
  } catch (error) {
    console.warn(
      "[electron-launcher] Failed to generate dev macOS icon, falling back to Electron icon.",
      error,
    );
    return defaultIconPath;
  } finally {
    rmSync(iconsetRoot, { recursive: true, force: true });
  }
}

function ensureDevelopmentIconAssets(sourceAppBundlePath) {
  const iconComposerAssets = compileIconComposerAssets();
  if (iconComposerAssets !== null) {
    return iconComposerAssets;
  }

  const iconPath = ensureDevelopmentIconIcns(sourceAppBundlePath);
  return {
    kind: "icns",
    iconPath,
    sourcePath: iconPath,
    sourceMtimeMs: statSync(iconPath).mtimeMs,
  };
}

function patchMainBundleInfoPlist(appBundlePath, iconAssets) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(
    infoPlistPath,
    "CFBundleDisplayName",
    appBranding.dev.displayName,
  );
  setPlistString(infoPlistPath, "CFBundleName", appBranding.dev.displayName);
  setPlistString(infoPlistPath, "CFBundleIdentifier", appBranding.dev.bundleId);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  if (iconAssets.kind === "icon-composer") {
    setPlistString(infoPlistPath, "CFBundleIconName", "Icon");
  }

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconAssets.iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconAssets.iconPath, join(resourcesDir, "electron.icns"));
  if (iconAssets.kind === "icon-composer") {
    copyFileSync(iconAssets.assetCatalogPath, join(resourcesDir, "Assets.car"));
  }
}

function hasExpectedFrameworkSymlinks(appBundlePath) {
  try {
    const frameworkPath = join(
      appBundlePath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );

    return (
      readlinkSync(join(frameworkPath, "Resources")) ===
        "Versions/Current/Resources" &&
      readlinkSync(join(frameworkPath, "Versions", "Current")) === "A"
    );
  } catch {
    return false;
  }
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  assertCompleteMacAppBundle(sourceAppBundlePath, "Source");

  const targetAppBundlePath = join(
    runtimeDir,
    `${appBranding.dev.displayName}.app`,
  );
  const targetBinaryPath = join(
    targetAppBundlePath,
    "Contents",
    "MacOS",
    "Electron",
  );
  const iconAssets = ensureDevelopmentIconAssets(sourceAppBundlePath);
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    displayName: appBranding.dev.displayName,
    bundleId: appBranding.dev.bundleId,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconKind: iconAssets.kind,
    iconPath: iconAssets.iconPath,
    iconSourcePath: iconAssets.sourcePath,
    iconSourceMtimeMs: iconAssets.sourceMtimeMs,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata) &&
    hasExpectedFrameworkSymlinks(targetAppBundlePath)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  assertCompleteMacAppBundle(targetAppBundlePath, "Copied runtime");
  patchMainBundleInfoPlist(targetAppBundlePath, iconAssets);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}
