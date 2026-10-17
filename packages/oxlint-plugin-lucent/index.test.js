/* oxlint-disable effecttsgo/node-builtin-import -- These integration tests run the real oxlint executable against temporary files. */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repo = path.resolve(__dirname, "../..");

const lint = (files) => {
  const directory = mkdtempSync(
    path.join(__dirname, "node_modules/.logging-lint-"),
  );
  try {
    const config = JSON.parse(
      readFileSync(path.join(repo, ".oxlintrc.json"), "utf8"),
    );
    config.extends = config.extends.map((entry) => path.resolve(repo, entry));
    config.jsPlugins = config.jsPlugins.map((entry) =>
      path.resolve(repo, entry),
    );
    writeFileSync(
      path.join(directory, ".oxlintrc.json"),
      JSON.stringify(config),
    );
    for (const [filename, source] of Object.entries(files)) {
      const target = path.join(directory, filename);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const result = spawnSync(
      path.join(repo, "node_modules/.bin/oxlint"),
      ["--disable-nested-config", "--format=json", ...Object.keys(files)],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    const { diagnostics } = JSON.parse(result.stdout);
    return {
      status: result.status,
      diagnostics: diagnostics.filter(({ code }) =>
        [
          "eslint(no-console)",
          "eslint(no-restricted-properties)",
          "lucent(log-message-literal)",
        ].includes(code),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

void test("requires a literal first argument at every allowed log level", () => {
  const result = lint({
    "app/src/main/logging.ts": [
      'Effect.logError("Failed", cause);',
      "Effect.logWarning('Recovered');",
      "Effect.logInfo(`Started`, details);",
      'Effect.logDebug("");',
      "Effect.logError(message);",
      "Effect.logWarning(`Failed ${details}`);",
      'Effect.logInfo("Started " + details);',
      "Effect.logDebug(42);",
      "Effect.logError();",
      "Effect.logWarning(...messages);",
      'Effect["logInfo"](message);',
      "Effect?.logDebug?.(message);",
      "logger.logInfo(message);",
      "Effect[method](message);",
      'logFailure("Failed", cause);',
      "logFailure(message, cause);",
    ].join("\n"),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(
    result.diagnostics.map(({ code, severity, labels }) => ({
      code,
      severity,
      line: labels[0].span.line,
    })),
    [5, 6, 7, 8, 9, 10, 11, 12, 16].map((line) => ({
      code: "lucent(log-message-literal)",
      severity: "error",
      line,
    })),
  );
});

void test("restricts console and unsupported levels in production main and shared files", () => {
  const source = [
    'console.error("Failed");',
    'Effect.log("Failed");',
    'Effect.logTrace("Failed");',
    'Effect.logFatal("Failed");',
    "Effect.logInfo(message);",
  ].join("\n");
  const result = lint({
    "app/src/main/logging.ts": source,
    "app/src/shared/nested/logging.ts": source,
    "app/src/main/logging.test.ts": source,
    "app/src/shared/nested/logging.test.ts": source,
    "app/src/renderer/logging.ts": source,
    "packages/example/logging.ts": source,
  });

  assert.equal(result.status, 1);
  assert.deepEqual(
    result.diagnostics
      .map(({ filename, code, severity }) => ({ filename, code, severity }))
      .toSorted((a, b) =>
        `${a.filename}:${a.code}`.localeCompare(`${b.filename}:${b.code}`),
      ),
    ["app/src/main/logging.ts", "app/src/shared/nested/logging.ts"].flatMap(
      (filename) =>
        [
          "eslint(no-console)",
          "eslint(no-restricted-properties)",
          "eslint(no-restricted-properties)",
          "eslint(no-restricted-properties)",
          "lucent(log-message-literal)",
        ].map((code) => ({ filename, code, severity: "error" })),
    ),
  );
  for (const diagnostic of result.diagnostics.filter(
    ({ code }) => code === "eslint(no-restricted-properties)",
  )) {
    assert.match(diagnostic.help, /logError, logWarning, logInfo, logDebug/u);
  }
});

void test("accepts literal messages and a documented last-resort console fallback", () => {
  const result = lint({
    "app/src/main/logging.ts": [
      'Effect.logError("Failed", cause);',
      "Effect.logWarning(`Recovered`);",
      'Effect.logInfo("Started");',
      'Effect.logDebug("Details", dynamicDetails);',
      "// oxlint-disable-next-line eslint/no-console -- The Effect runtime has failed, so its logger is unavailable.",
      'console.error("Runtime failed", cause);',
    ].join("\n"),
  });

  assert.deepEqual(result, { status: 0, diagnostics: [] });
});
