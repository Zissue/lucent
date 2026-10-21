const { build, context } = require("esbuild");
const { solidPlugin } = require("esbuild-plugin-solid");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync,
  appendFileSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const runtimeTargets = require("./runtime-targets.json");

const isProduction = process.env.NODE_ENV === "production";
const isWatch = process.argv.includes("--watch") || process.argv.includes("-w");
const skipInitialBuildNotify =
  process.env.LUCENT_DEV_BUILD_NOTIFY_SKIP_INITIAL === "1";
const notifiedBuilds = new Set();
const staticAssetWatchIntervalMs = 100;
const devRunnerOwnerPollIntervalMs = 1_000;
const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const noop = () => {};

const readGit = (args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const readBuildInfo = () => {
  const commit = readGit(["rev-parse", "--short", "HEAD"]);
  return {
    builtAt: new Date().toISOString(),
    commit,
    dirty: commit !== null && (readGit(["status", "--porcelain"]) ?? "") !== "",
  };
};

const baseOptions = {
  bundle: true,
  logLevel: "info",
  minify: isProduction,
  sourcemap: !isProduction,
  sourcesContent: false,
};

const wsOptionalNativeAddons = ["bufferutil", "utf-8-validate"];

const mainOptions = {
  ...baseOptions,
  define: {
    __LUCENT_BUILD_INFO__: JSON.stringify(readBuildInfo()),
  },
  entryNames: "[name]",
  entryPoints: {
    index: "src/main/index.ts",
  },
  external: ["electron", ...wsOptionalNativeAddons],
  format: "cjs",
  outdir: "dist/main",
  platform: "node",
  target: `node${runtimeTargets.node}`,
};

const sharedCssOptions = {
  ...baseOptions,
  assetNames: "assets/[name]-[hash]",
  entryPoints: ["src/renderer/styles.css"],
  loader: {
    ".woff2": "file",
  },
  outfile: "dist/renderer/styles.css",
};

const preloadOptions = {
  ...baseOptions,
  entryPoints: ["src/main/preload.ts"],
  external: ["electron"],
  format: "cjs",
  outfile: "dist/renderer/preload.js",
  platform: "node",
  target: `node${runtimeTargets.node}`,
};

const rendererThemeBootstrapScript =
  'document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";';

const contentSecurityPolicyHash = (source) =>
  `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

const rendererScriptSources = [
  "'self'",
  contentSecurityPolicyHash(rendererThemeBootstrapScript),
];

const formatRendererContentSecurityPolicy = (overrides = {}) =>
  Object.entries({
    "default-src": ["'self'"],
    "script-src": rendererScriptSources,
    "style-src": ["'self'", "'unsafe-inline'"],
    ...overrides,
  })
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join("; ");

const createRendererView = (
  id,
  title,
  {
    framework = "solid",
    sourceDir = `src/renderer/apps/${id}`,
    ...options
  } = {},
) => ({
  entryPoint: `${sourceDir}/index.tsx`,
  framework,
  id,
  sourceDir,
  title,
  ...options,
});

const rendererViews = [
  createRendererView("game-group-controls", "Group Controls", {
    sourceDir: "src/renderer/apps/game-host/group-controls",
  }),
  createRendererView("game-host", "Lucent"),
  createRendererView("game", "Lucent", {
    contentSecurityPolicy: {
      "default-src": [
        "'self'",
        "lucent-asset:",
        "https://*.aq.com",
        "https://*.aqworlds.com",
        "https://*.artix.com",
        "ws://127.0.0.1:*",
        "data:",
        "blob:",
      ],
      "script-src": [
        ...rendererScriptSources,
        "'unsafe-eval'",
        "lucent-asset:",
        "blob:",
      ],
    },
    bodyHtml: [
      '    <div id="swf"></div>',
      '    <script src="lucent-asset://assets/ruffle/ruffle.js"></script>',
    ].join("\n"),
  }),
  createRendererView("settings", "Settings", {
    framework: "react",
    startsPending: true,
  }),
  createRendererView("about", "About", {
    framework: "react",
    startsPending: true,
  }),
  createRendererView("account-manager", "Account Manager", {
    startsPending: true,
  }),
  createRendererView("combat-profiles", "Combat Profiles", {
    framework: "react",
    startsPending: true,
  }),
  createRendererView("environment", "Environment", {
    framework: "react",
    startsPending: true,
  }),
  createRendererView("follower", "Follower", { startsPending: true }),
  createRendererView("loader-grabber", "Loader Grabber", {
    framework: "react",
    startsPending: true,
  }),
  createRendererView("packets", "Packets", { startsPending: true }),
];

const rendererEntryPoints = (framework) =>
  Object.fromEntries(
    rendererViews
      .filter((view) => view.framework === framework)
      .map((view) => [view.id, view.entryPoint]),
  );

const rendererBaseOptions = {
  ...baseOptions,
  chunkNames: "chunks/[name]-[hash]",
  entryNames: "[name]/index",
  format: "esm",
  outdir: "dist/renderer",
  platform: "browser",
  splitting: true,
  target: `chrome${runtimeTargets.chrome}`,
};

const rendererOptions = {
  ...rendererBaseOptions,
  entryPoints: rendererEntryPoints("solid"),
  plugins: [solidPlugin()],
};

const reactRendererOptions = {
  ...rendererBaseOptions,
  entryPoints: rendererEntryPoints("react"),
  jsx: "automatic",
  jsxImportSource: "react",
};

const rendererIndexHtml = (view) => {
  const startsPendingAttribute = view.startsPending
    ? ' data-ready="false"'
    : "";
  const body = typeof view.bodyHtml === "string" ? `${view.bodyHtml}\n` : "";
  const contentSecurityPolicy = formatRendererContentSecurityPolicy(
    view.contentSecurityPolicy,
  );
  const sharedStylesheet =
    view.framework === "react" ? "./index.css" : "../styles.css";

  return `<!doctype html>
<html lang="en"${startsPendingAttribute}>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="${contentSecurityPolicy}"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${view.title}</title>
    <script>${rendererThemeBootstrapScript}</script>
    <link rel="stylesheet" href="${sharedStylesheet}" />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
${body}    <div id="root"></div>
    <script type="module" src="./index.js"></script>
  </body>
</html>
`;
};

const copyRendererFiles = () => {
  for (const view of rendererViews) {
    const targetDir = `dist/renderer/${view.id}`;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(`${targetDir}/index.html`, rendererIndexHtml(view));

    const stylePath = `${view.sourceDir}/style.css`;
    const targetStylePath = `${targetDir}/style.css`;
    if (existsSync(stylePath)) {
      copyFileSync(stylePath, targetStylePath);
    } else if (existsSync(targetStylePath)) {
      unlinkSync(targetStylePath);
    }
  }
};

const removeRecursive = (path) => {
  if (!existsSync(path)) {
    return;
  }

  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    unlinkSync(path);
    return;
  }

  for (const entry of readdirSync(path)) {
    removeRecursive(join(path, entry));
  }
  rmdirSync(path);
};

const clean = () => {
  removeRecursive("dist");
};

const notifyBuild = (label, options = {}) => {
  const notifyPath = process.env.LUCENT_DEV_BUILD_NOTIFY;
  if (!notifyPath) {
    return;
  }

  const initialBuildKey = options.initialBuildKey ?? label;

  if (
    options.skipInitial !== false &&
    skipInitialBuildNotify &&
    !notifiedBuilds.has(initialBuildKey)
  ) {
    notifiedBuilds.add(initialBuildKey);
    return;
  }
  notifiedBuilds.add(initialBuildKey);

  mkdirSync(dirname(notifyPath), { recursive: true });
  appendFileSync(
    notifyPath,
    `${JSON.stringify({
      label,
      labels: [label],
      pid: process.pid,
      time: Date.now(),
    })}\n`,
  );
};

const rendererStaticFilePaths = () =>
  rendererViews.map((view) => `${view.sourceDir}/style.css`);

const fileChanged = (current, previous) =>
  current.mtimeMs !== previous.mtimeMs ||
  current.ctimeMs !== previous.ctimeMs ||
  current.size !== previous.size ||
  current.ino !== previous.ino;

const watchRendererStaticFiles = () => {
  const watchedPaths = rendererStaticFilePaths();
  const listener = (current, previous) => {
    if (!fileChanged(current, previous)) {
      return;
    }

    try {
      copyRendererFiles();
      notifyBuild("renderer-html", { skipInitial: false });
    } catch (error) {
      console.error("Failed to copy renderer static files", error);
    }
  };

  for (const path of watchedPaths) {
    watchFile(path, { interval: staticAssetWatchIntervalMs }, listener).unref();
  }

  return () => {
    for (const path of watchedPaths) {
      unwatchFile(path, listener);
    }
  };
};

const watchLoaderSwf = () => {
  const loaderPath = join("..", "assets", "loader.swf");
  const listener = (current, previous) => {
    if (!fileChanged(current, previous)) {
      return;
    }

    notifyBuild("renderer", { skipInitial: false });
  };

  watchFile(
    loaderPath,
    { interval: staticAssetWatchIntervalMs },
    listener,
  ).unref();

  return () => {
    unwatchFile(loaderPath, listener);
  };
};

const buildOnce = async () => {
  clean();
  await Promise.all([
    build(mainOptions),
    build(rendererOptions),
    build(reactRendererOptions),
    build(sharedCssOptions),
    build(preloadOptions),
  ]);
  copyRendererFiles();
};

const notifyPlugin = (name, label, initialBuildKey) => ({
  name,
  setup(pluginBuild) {
    pluginBuild.onEnd((result) => {
      if (result.errors.length === 0) {
        notifyBuild(label, { initialBuildKey });
      }
    });
  },
});

const parseDevRunnerPid = () => {
  const value = Number(process.env.LUCENT_DEV_RUNNER_PID);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const watchDevRunnerOwner = (onOwnerExit) => {
  const ownerPid = parseDevRunnerPid();
  if (ownerPid === null) {
    return noop;
  }

  const timer = setInterval(() => {
    if (!isProcessAlive(ownerPid)) {
      onOwnerExit(ownerPid);
    }
  }, devRunnerOwnerPollIntervalMs);
  timer.unref();

  return () => clearInterval(timer);
};

const watch = async () => {
  if (!skipInitialBuildNotify) {
    clean();
  }
  const contexts = await Promise.all([
    context({
      ...mainOptions,
      plugins: [notifyPlugin("lucent-main-watch-notify", "main", "main")],
    }),
    ...[
      { initialBuildKey: "renderer", options: rendererOptions },
      { initialBuildKey: "react-renderer", options: reactRendererOptions },
    ].map(({ initialBuildKey, options }) =>
      context({
        ...options,
        plugins: [
          ...(options.plugins ?? []),
          {
            name: `lucent-${initialBuildKey}-watch-copy`,
            setup(pluginBuild) {
              pluginBuild.onEnd((result) => {
                if (result.errors.length === 0) {
                  copyRendererFiles();
                  notifyBuild("renderer", { initialBuildKey });
                }
              });
            },
          },
        ],
      }),
    ),
    context({
      ...preloadOptions,
      plugins: [
        notifyPlugin("lucent-preload-watch-notify", "renderer", "preload"),
      ],
    }),
    context({
      ...sharedCssOptions,
      plugins: [
        notifyPlugin(
          "lucent-shared-css-watch-notify",
          "renderer",
          "shared-css",
        ),
      ],
    }),
  ]);

  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  copyRendererFiles();
  const stopStaticWatchers = [watchRendererStaticFiles(), watchLoaderSwf()];
  let cleanupPromise;
  let stopOwnerWatch = noop;

  const cleanup = () => {
    cleanupPromise ??= Promise.resolve().then(async () => {
      stopOwnerWatch();
      for (const stopStaticWatcher of stopStaticWatchers) {
        stopStaticWatcher();
      }
      await Promise.allSettled(
        contexts.map((buildContext) => buildContext.dispose()),
      );
      for (const signal of terminationSignals) {
        process.removeListener(signal, signalHandlers.get(signal));
      }
    });
    return cleanupPromise;
  };

  const exitAfterCleanup = (exitCode) => {
    void cleanup().finally(() => process.exit(exitCode));
  };

  const signalHandlers = new Map(
    terminationSignals.map((signal) => [
      signal,
      () => exitAfterCleanup(signal === "SIGINT" ? 130 : 0),
    ]),
  );
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  stopOwnerWatch = watchDevRunnerOwner((ownerPid) => {
    console.error(
      `[watch] dev runner ${ownerPid} is no longer alive; stopping compiler`,
    );
    exitAfterCleanup(0);
  });
};

const run = isWatch ? watch : buildOnce;

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
