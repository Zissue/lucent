import {
  BaseWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
} from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ElectronDialogMessageBoxError extends Schema.TaggedError<ElectronDialogMessageBoxError>()(
  "ElectronDialogMessageBoxError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to show Electron message box.";
  }
}

export class ElectronDialogOpenDialogError extends Schema.TaggedError<ElectronDialogOpenDialogError>()(
  "ElectronDialogOpenDialogError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to show Electron open dialog.";
  }
}

export interface ElectronDialogShape {
  readonly showMessageBox: (
    options: MessageBoxOptions,
    parentWindowId?: number,
  ) => Effect.Effect<MessageBoxReturnValue, ElectronDialogMessageBoxError>;
  readonly showOpenDialog: (
    options: OpenDialogOptions,
    parentWindowId?: number,
  ) => Effect.Effect<OpenDialogReturnValue, ElectronDialogOpenDialogError>;
}

export class ElectronDialog extends Context.Service<
  ElectronDialog,
  ElectronDialogShape
>()("lucent/desktop/electron/ElectronDialog") {}

const showMessageBox: ElectronDialogShape["showMessageBox"] = (
  options,
  parentWindowId,
) =>
  Effect.tryPromise({
    try: (signal) => {
      if (parentWindowId === undefined) {
        return dialog.showMessageBox({ ...options, signal });
      }

      const browserWindow = BaseWindow.fromId(parentWindowId);
      if (browserWindow === null) {
        throw new Error(`Browser window is not open: ${parentWindowId}`);
      }
      return dialog.showMessageBox(browserWindow, { ...options, signal });
    },
    catch: (cause) => new ElectronDialogMessageBoxError({ cause }),
  });

const showOpenDialog: ElectronDialogShape["showOpenDialog"] = (
  options,
  parentWindowId,
) =>
  Effect.tryPromise({
    try: () => {
      if (parentWindowId === undefined) {
        return dialog.showOpenDialog(options);
      }

      const browserWindow = BaseWindow.fromId(parentWindowId);
      if (browserWindow === null) {
        throw new Error(`Browser window is not open: ${parentWindowId}`);
      }
      return dialog.showOpenDialog(browserWindow, options);
    },
    catch: (cause) => new ElectronDialogOpenDialogError({ cause }),
  });

export const layer = Layer.succeed(
  ElectronDialog,
  ElectronDialog.of({
    showMessageBox,
    showOpenDialog,
  }),
);
