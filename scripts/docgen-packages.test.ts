import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverScriptPackages } from "./docgen-packages";
import { renderPackageReferences } from "./docgen";

describe("script package references", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(join(tmpdir(), "lucent-docgen-"));
    await fs.mkdir(join(repoRoot, "script-packages"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const addPackage = async (
    name: string,
    declarations?: string,
    types = "index.d.ts",
  ) => {
    const directory = join(repoRoot, "script-packages", name);
    await fs.mkdir(directory);
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `@test/${name}`,
        description: `${name} helpers`,
        version: "1.2.3",
        ...(declarations === undefined ? {} : { types }),
      }),
    );
    if (declarations !== undefined)
      await fs.writeFile(join(directory, "index.d.ts"), declarations);
  };

  const generate = async () => {
    const packages = await discoverScriptPackages(repoRoot);
    const program = ts.createProgram({
      rootNames: packages.flatMap((pkg) =>
        pkg.typesFile === undefined ? [] : [pkg.typesFile],
      ),
      options: {
        target: ts.ScriptTarget.ESNext,
        types: [],
        skipLibCheck: true,
      },
    });
    return renderPackageReferences(
      program,
      packages,
      {
        repoRoot,
        outputDir: join(repoRoot, "output"),
        sourceFile: "",
        includeSourceLinks: false,
      },
      null,
      new Map([
        [
          "Options",
          { href: "/reference/scripting/types/options/", slug: "options" },
        ],
      ]),
      (code) => `\`\`\`ts\n${code}\n\`\`\``,
    );
  };

  it("discovers additions and removals, keeping same-named types and generator calls local to each package", async () => {
    await addPackage(
      "first",
      `declare module "@test/first" {
      export interface Options { readonly firstOnly: string; }
      /** Start the first operation.
       * @param options Configuration for the operation.
       * @example
       * \`\`\`js
       * yield* first.run({ firstOnly: "yes" });
       * \`\`\`
       */
      export function run(options: Options): ScriptGenerator<Options>;
      export const names: readonly string[];
    }`,
    );
    expect(await generate()).toHaveLength(2);
    await addPackage(
      "second",
      `export interface Options { readonly secondOnly: number; }
      export function run(options: Options): ScriptGenerator<Options>;`,
    );
    const files = await generate();
    const first = files.find((file) =>
      file.path.endsWith(join("test", "first", "index.md")),
    )!.content;
    const second = files.find((file) =>
      file.path.endsWith(join("test", "second", "index.md")),
    )!.content;
    expect(files[0]!.content).toContain(
      "/reference/scripting/packages/test/second/",
    );
    expect(first).toContain('href="#type-options"');
    expect(second).toContain('href="#type-options"');
    expect(first).toContain("firstOnly: string");
    expect(first).not.toContain("secondOnly");
    expect(second).toContain("secondOnly: number");
    expect(second).not.toContain("firstOnly");
    expect(first).toContain('const first = require("@test/first");');
    expect(first).toContain("### `run()`");
    expect(first).toContain("### `names`");
    expect(first).toContain('data-api-copy-call="yield* first.run(options);"');
    expect(first).toContain('data-api-copy-call="first.names"');
    expect(first).toContain(
      '**Returns:** <a href="#type-options"><code>Options</code></a>',
    );
    expect(first).not.toContain("**Errors:** `never`");
    expect(first).not.toContain("data-script-type-preview");
    expect(first).toContain("Configuration for the operation.");
    expect(first).toContain('yield* first.run({ firstOnly: "yes" });');
    expect(first).toContain("1.2.3");
    await fs.rm(join(repoRoot, "script-packages/first"), { recursive: true });
    const remaining = await generate();
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.content).not.toContain("@test/first");
  });

  it("lists script-only packages without inventing a public API", async () => {
    await addPackage("scripts");
    const files = await generate();
    expect(files[0]!.content).toContain("@test/scripts");
    expect(files[1]!.content).not.toContain("require(");
    expect(files[1]!.content).not.toContain("## Exports");
  });

  it("rejects a declared but missing types file instead of silently omitting the API", async () => {
    await addPackage("missing", "export {};", "missing.d.ts");
    await expect(generate()).rejects.toThrow("missing.d.ts");
  });

  it("rejects a declaration module that does not match the package name", async () => {
    await addPackage(
      "mismatch",
      'declare module "@test/other" { export function run(): void; }',
    );
    await expect(generate()).rejects.toThrow('declare module "@test/mismatch"');
  });

  it("rejects packages that would overwrite the same documentation route", async () => {
    await addPackage("first");
    await addPackage("second");
    await fs.writeFile(
      join(repoRoot, "script-packages/second/package.json"),
      JSON.stringify({ name: "test/FIRST" }),
    );
    await expect(generate()).rejects.toThrow(
      "Duplicate script package name or documentation route",
    );
  });
});
