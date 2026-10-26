import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const native = join(root, "app", "src", "native");
const outDir = join(root, "assets", "native");

const bundles = [
  { name: "account", entry: join(native, "account", "entry.ts") },
  { name: "hub", entry: join(native, "hub", "entry.ts") },
] as const;

const build = async (only: readonly string[]): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  for (const bundle of bundles) {
  if (only.length > 0 && !only.includes(bundle.name)) continue;
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [bundle.entry],
    outfile: join(outDir, `${bundle.name}.js`),
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2024",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    tsconfig: join(root, "app", "tsconfig.json"),
    alias: {
      "@lucent/game": join(root, "packages", "game", "src", "index.ts"),
      ...(bundle.name === "hub" ? hubAliases() : {}),
    },
    define:
      bundle.name === "hub"
        ? {
            __dirname: JSON.stringify("/"),
            __LUCENT_VERSION__: JSON.stringify(await appVersion()),
          }
        : {},
    legalComments: "none",
    minify: process.env["NODE_ENV"] === "production",
    keepNames: true,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
  });
  await writeFile(
    join(outDir, `${bundle.name}.meta.json`),
    JSON.stringify(result.metafile),
  );
  const bytes = Object.values(result.metafile?.outputs ?? {})[0]?.bytes ?? 0;
  console.log(`Built ${bundle.name}.js (${(bytes / 1024).toFixed(0)} KiB)`);
  }
};

async function appVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(root, "app", "package.json"), "utf8"),
  ) as { readonly version: string };
  return manifest.version;
}

function hubAliases(): Record<string, string> {
  const shims = join(native, "hub", "node");
  return {
    "node:path": join(shims, "path.ts"),
    "node:crypto": join(shims, "crypto.ts"),
    "node:util": join(shims, "util.ts"),
    "node:os": join(shims, "os.ts"),
    "node:fs": join(shims, "fs.ts"),
    "node:fs/promises": join(shims, "fs-promises.ts"),
    "@effect/platform-node/NodeFileSystem": join(shims, "NodeFileSystem.ts"),
    "@effect/platform-node/NodeHttpClient": join(shims, "NodeHttpClient.ts"),
    "@effect/platform-node/NodeHttpIncomingMessage": join(shims, "NodeHttpIncomingMessage.ts"),
    "node:http": join(shims, "unsupported.ts"),
    "node:net": join(shims, "net.ts"),
    "node:stream": join(shims, "unsupported.ts"),
    "node:url": join(shims, "unsupported.ts"),
    electron: join(shims, "electron.ts"),
    ws: join(shims, "unsupported.ts"),
    undici: join(shims, "unsupported.ts"),
    tar: join(shims, "unsupported.ts"),
  };
}

build(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
