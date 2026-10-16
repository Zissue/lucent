import { defineComponents } from "blume";

import EnhancementLabels from "./components/EnhancementLabels.astro";

export default defineComponents({
  layout: {
    Header: "./components/Header.astro",
    Layout: "./components/Layout.astro",
    PageFooter: "./components/DocsController.astro",
    Search: "./components/Search.astro",
    Sidebar: "./components/Sidebar.astro",
    TableOfContents: "./components/TableOfContents.astro",
  },
  mdx: {
    EnhancementLabels,
  },
});
