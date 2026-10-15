import type { MessageBoxOptions } from "electron";

import * as Effect from "effect/Effect";

import type { UpdateCheckState } from "../../shared/updates";
import type { ElectronDialogShape } from "../electron/ElectronDialog";
import type { DesktopUpdatesShape } from "../updates/DesktopUpdates";

interface UpdateCheckDialogPresentation {
  readonly options: MessageBoxOptions;
  readonly skipVersionButtonIndex?: number;
  readonly viewReleaseButtonIndex?: number;
}

interface ShowUpdateCheckDialogOptions {
  readonly mode: "automatic" | "manual";
  readonly parentWindowId?: number;
  readonly isQuitting: Effect.Effect<boolean>;
  readonly dialog: Pick<ElectronDialogShape, "showMessageBox">;
  readonly updates: Pick<
    DesktopUpdatesShape,
    | "openReleasePage"
    | "shouldPromptForAvailableRelease"
    | "skipAvailableRelease"
  >;
}

const closeButtonOptions: Pick<
  MessageBoxOptions,
  "buttons" | "cancelId" | "defaultId"
> = {
  buttons: ["Close"],
  defaultId: 0,
  cancelId: 0,
};

export const makeUpdateCheckDialog = (
  state: UpdateCheckState,
): UpdateCheckDialogPresentation | null => {
  switch (state.status) {
    case "idle":
    case "checking":
      return null;
    case "disabled":
      return {
        options: {
          type: "warning",
          title: "Update checks are unavailable",
          message: "Lucent could not check for updates.",
          detail: state.reason,
          ...closeButtonOptions,
        },
      };
    case "current":
      return {
        options: {
          type: "info",
          title: "No updates available",
          message: `Lucent ${state.currentVersion} is up to date.`,
          ...closeButtonOptions,
        },
      };
    case "available":
      return {
        options: {
          type: "info",
          title: "Update available",
          message: `Lucent ${state.latestVersion} is available.`,
          detail: `You are currently using Lucent ${state.currentVersion}. You will be notified again when a newer version is available.`,
          buttons: ["View release", "Not now"],
          defaultId: 0,
          cancelId: 1,
        },
        skipVersionButtonIndex: 1,
        viewReleaseButtonIndex: 0,
      };
    case "error":
      return {
        options: {
          type: "warning",
          title: "Unable to check for updates",
          message: "Lucent could not check for updates.",
          detail: `${state.message}\n\nTry again later.`,
          ...closeButtonOptions,
        },
      };
  }
};

export const showUpdateCheckDialog = Effect.fn("showUpdateCheckDialog")(
  function* (state: UpdateCheckState, options: ShowUpdateCheckDialogOptions) {
    if (options.mode === "automatic") {
      if (state.status !== "available") {
        return;
      }

      const shouldPrompt =
        yield* options.updates.shouldPromptForAvailableRelease(
          state.latestVersion,
        );
      if (!shouldPrompt) {
        return;
      }
    }

    const presentation = makeUpdateCheckDialog(state);
    if (presentation === null) {
      return;
    }

    const response = yield* options.dialog.showMessageBox(
      presentation.options,
      options.parentWindowId,
    );
    if (yield* options.isQuitting) {
      return;
    }
    if (
      presentation.viewReleaseButtonIndex !== undefined &&
      response.response === presentation.viewReleaseButtonIndex
    ) {
      yield* options.updates.openReleasePage;
      return;
    }

    if (
      state.status === "available" &&
      presentation.skipVersionButtonIndex !== undefined &&
      response.response === presentation.skipVersionButtonIndex
    ) {
      yield* options.updates.skipAvailableRelease(state.latestVersion);
    }
  },
);
