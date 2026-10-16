import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "blume";

import { changelogSource } from "./changelog-source.ts";

const scriptingReferenceRoot = fileURLToPath(
  new URL("./src/content/docs/reference/scripting", import.meta.url),
);

/** Collect the page routes directly inside a documentation directory. */
const collectPageRoutes = (directory: string, routeRoot: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")),
    )
    .map((entry) => entry.name.replace(/\.mdx?$/u, ""))
    .toSorted((left, right) => {
      if (left === "index") {
        return -1;
      }
      if (right === "index") {
        return 1;
      }
      return left.localeCompare(right);
    })
    .map((name) => (name === "index" ? routeRoot : `${routeRoot}/${name}`));

/** Collect routes generated below the scripting reference root. */
const collectRouteSuffixes = (
  directory: string,
  segments: readonly string[] = [],
): string[] => {
  const suffixes: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      suffixes.push(
        ...collectRouteSuffixes(join(directory, entry.name), [
          ...segments,
          entry.name,
        ]),
      );
      continue;
    }

    const extension = entry.name.endsWith(".mdx")
      ? ".mdx"
      : entry.name.endsWith(".md")
        ? ".md"
        : null;
    if (extension === null) {
      continue;
    }

    const name = entry.name.slice(0, -extension.length);
    const routeSegments = name === "index" ? segments : [...segments, name];
    suffixes.push(
      routeSegments.length === 0 ? "" : `/${routeSegments.join("/")}`,
    );
  }

  return suffixes.toSorted();
};

const legacyScriptingRedirects = collectRouteSuffixes(
  scriptingReferenceRoot,
).flatMap((suffix) => {
  const destination = `/reference/scripting${suffix}`;
  const redirects = [{ from: `/scripting${suffix}`, to: destination }];

  if (suffix === "/types" || suffix.startsWith("/types/")) {
    redirects.push({
      from: suffix,
      to: destination,
    });
  }

  return redirects;
});

const redirects = [
  {
    from: "/docs/scripting",
    to: "/docs/scripting/script-format",
  },
  {
    from: "/reference/scripting/imports",
    to: "/docs/scripting/script-format",
  },
  {
    from: "/reference/scripting/api",
    to: "/reference/scripting",
  },
  {
    from: "/reference/scripting/features",
    to: "/reference/scripting",
  },
  ...legacyScriptingRedirects,
];

const moduleGroup = (label: string, segment: string) => {
  const routeRoot = `/reference/scripting/${segment}`;

  return {
    display: "group" as const,
    items: collectPageRoutes(join(scriptingReferenceRoot, segment), routeRoot),
    label,
  };
};

export default defineConfig({
  analytics: {
    vercel: true,
  },
  content: {
    root: "src/content/docs",
    sources: [
      { type: "filesystem", root: "src/content/docs" },
      { type: "custom", source: changelogSource },
    ],
  },
  description: "Docs and reference for Lucent.",
  github: {
    dir: "docs",
    owner: "toommyliu",
    repo: "lucent",
  },
  lastModified: true,
  navigation: {
    sidebar: {
      display: "flat",
      items: [
        {
          items: [
            "/docs/installation",
            "/docs/app",
            "/docs/combat-profiles",
            {
              items: [
                "/docs/scripting/script-format",
                "/docs/scripting/script-inputs",
                "/docs/scripting/script-packages",
                "/docs/scripting/editor-setup",
                {
                  items: [
                    "/docs/scripting/armying/army",
                    "/docs/scripting/armying/loop-taunt",
                  ],
                  label: "Armying",
                },
              ],
              label: "Scripting",
            },
            {
              items: [
                "/docs/concepts/durations",
                "/docs/concepts/queries-and-selectors",
                "/docs/concepts/enhancements",
                "/docs/concepts/error-handling",
              ],
              label: "Concepts",
            },
          ],
          label: "Docs",
          root: "/docs",
        },
        {
          items: [
            "/reference/cli",
            "/reference/scripting",
            "/reference/scripting/types",
            moduleGroup("lucent/api", "api"),
            {
              items: [
                {
                  label: "lucent/script",
                  root: "/reference/scripting/script",
                },
                {
                  label: "lucent/schema",
                  root: "/reference/scripting/schema",
                },
                {
                  label: "lucent/http",
                  root: "/reference/scripting/http",
                },
                {
                  label: "lucent/filesystem",
                  root: "/reference/scripting/filesystem",
                },
                {
                  label: "lucent/autozone",
                  root: "/reference/scripting/autozone",
                },
                {
                  label: "lucent/autorelogin",
                  root: "/reference/scripting/autorelogin",
                },
                {
                  label: "effect",
                  root: "/reference/scripting/effect",
                },
              ],
              label: "Modules",
            },
            {
              items: [
                {
                  label: "Overview",
                  root: "/reference/scripting/packages",
                },
                ...collectRouteSuffixes(
                  join(scriptingReferenceRoot, "packages"),
                )
                  .filter((suffix) => suffix !== "")
                  .map((suffix) => `/reference/scripting/packages${suffix}`),
              ],
              label: "Packages",
            },
          ],
          label: "Reference",
          root: "/reference",
        },
      ],
    },
    tabs: [
      {
        href: "/docs",
        icon: "book-open",
        label: "Docs",
        path: "/docs",
      },
      {
        href: "/reference",
        icon: "braces",
        label: "Reference",
        path: "/reference",
      },
      {
        href: "/changelog",
        icon: "history",
        label: "Changelog",
        path: "/changelog",
      },
    ],
  },
  redirects,
  seo: {
    og: {
      logo: "/icon.svg",
    },
  },
  theme: {
    fonts: {
      body: "inter",
      display: "inter",
      mono: "jetbrains-mono",
    },
    mode: "system",
  },
  title: "Lucent",
  toc: {
    maxHeadingLevel: 3,
    minHeadingLevel: 2,
  },
});
