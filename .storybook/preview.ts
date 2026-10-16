import { withThemeByDataAttribute } from "@storybook/addon-themes";
import type { Preview } from "storybook-solidjs-vite";

import "../app/src/renderer/styles.css";
import "../app/src/renderer/apps/account-manager/style.css";
import "../app/src/renderer/apps/combat-profiles/style.css";
import "../app/src/renderer/apps/follower/style.css";
import "../app/src/renderer/apps/game/style.css";
import "../app/src/renderer/apps/loader-grabber/style.css";
import "../app/src/renderer/apps/packets/style.css";
import "../app/src/renderer/apps/settings/style.css";
import "./preview.css";

import { rendererViewports } from "./viewports";

// Storybook's interaction harness wraps HTMLElement.focus when Clipboard is
// present, which conflicts with Zag's prototype-level focus tracking.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: undefined,
});

const preview = {
  decorators: [
    withThemeByDataAttribute({
      attributeName: "data-theme",
      defaultTheme: "dark",
      themes: {
        dark: "dark",
        light: "light",
      },
    }),
  ],
  parameters: {
    controls: {
      expanded: true,
    },
    layout: "fullscreen",
    viewport: {
      options: rendererViewports,
    },
  },
} satisfies Preview;

export default preview;
