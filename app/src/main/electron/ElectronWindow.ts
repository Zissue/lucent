import {
  BrowserWindow,
  BaseWindow,
  WebContentsView,
  type WebContentsViewConstructorOptions,
  type BaseWindowConstructorOptions,
  type LoadFileOptions,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export {
  isElectronWindowUsable,
  type ElectronWindowUsabilityTarget,
} from "./windowUsability";
import { isElectronWindowUsable } from "./windowUsability";
import { electronRendererRegistry } from "./ElectronRendererRegistry";

export interface ElectronGameViewHandle {
  readonly native: WebContentsView;
  readonly webContents: WebContents;
  readonly getBounds: WebContentsView["getBounds"];
  readonly setBounds: WebContentsView["setBounds"];
  readonly setBackgroundColor: WebContentsView["setBackgroundColor"];
}

export interface ElectronWindowWebContents {
  readonly focus: WebContents["focus"];
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly on: WebContents["on"];
  readonly once: WebContents["once"];
  readonly removeListener: WebContents["removeListener"];
  readonly openDevTools: WebContents["openDevTools"];
  readonly send: WebContents["send"];
  readonly loadFile: WebContents["loadFile"];
}

export interface ElectronNativeWindowHandle {
  readonly id: number;
  readonly contentView: BaseWindow["contentView"];
  readonly close: () => void;
  readonly destroy: () => void;
  readonly focus: () => void;
  readonly hide: () => void;
  readonly isDestroyed: () => boolean;
  readonly isFocused: () => boolean;
  readonly isMinimized: () => boolean;
  readonly isVisible: () => boolean;
  readonly getContentBounds: BrowserWindow["getContentBounds"];
  readonly on: BaseWindow["on"];
  readonly once: BaseWindow["once"];
  readonly removeListener: BaseWindow["removeListener"];
  readonly restore: () => void;
  readonly setBackgroundColor: (backgroundColor: string) => void;
  readonly setMenuBarVisibility: (visible: boolean) => void;
  readonly setTitle: (title: string) => void;
  readonly show: () => void;
}

export interface ElectronWindowHandle extends ElectronNativeWindowHandle {
  readonly webContents: ElectronWindowWebContents;
  readonly on: BrowserWindow["on"];
  readonly once: BrowserWindow["once"];
}

export type ElectronHostWindowCreateOptions = BaseWindowConstructorOptions & {
  readonly height: number;
  readonly width: number;
};

export class ElectronWindowCreateError extends Schema.TaggedError<ElectronWindowCreateError>()(
  "ElectronWindowCreateError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create Electron window.";
  }
}

export class ElectronWindowLoadError extends Schema.TaggedError<ElectronWindowLoadError>()(
  "ElectronWindowLoadError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load Electron window file: ${this.path}.`;
  }
}

export type ElectronWindowCreateOptions = BrowserWindowConstructorOptions & {
  readonly height: number;
  readonly width: number;
};

export type ElectronWindowOpenRequestHandler = (url: string) => void;

export interface ElectronWindowShape {
  readonly createHost: (
    options: ElectronHostWindowCreateOptions,
  ) => Effect.Effect<
    ElectronNativeWindowHandle,
    ElectronWindowCreateError,
    Scope.Scope
  >;
  readonly create: (
    options: ElectronWindowCreateOptions,
    onWindowOpenRequest?: ElectronWindowOpenRequestHandler,
  ) => Effect.Effect<
    ElectronWindowHandle,
    ElectronWindowCreateError,
    Scope.Scope
  >;
  readonly createView: (
    options: WebContentsViewConstructorOptions,
    onWindowOpenRequest?: ElectronWindowOpenRequestHandler,
  ) => Effect.Effect<
    ElectronGameViewHandle,
    ElectronWindowCreateError,
    Scope.Scope
  >;
  readonly loadFile: (
    webContents: Pick<WebContents, "loadFile">,
    path: string,
    options?: LoadFileOptions,
  ) => Effect.Effect<void, ElectronWindowLoadError>;
  readonly reveal: (window: ElectronNativeWindowHandle) => Effect.Effect<void>;
}

export class ElectronWindow extends Context.Service<
  ElectronWindow,
  ElectronWindowShape
>()("lucent/desktop/electron/ElectronWindow") {}

/** Keeps a renderer on its document; blocked URLs go to the open-request handler. */
export const guardRendererNavigation = (
  webContents: Pick<WebContents, "getURL" | "on" | "setWindowOpenHandler">,
  onWindowOpenRequest?: ElectronWindowOpenRequestHandler,
): void => {
  webContents.setWindowOpenHandler(({ url }) => {
    onWindowOpenRequest?.(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event) => {
    // Renderer-initiated reloads arrive here with the current URL.
    if (event.url === webContents.getURL()) {
      return;
    }

    event.preventDefault();
    onWindowOpenRequest?.(event.url);
  });
};

const create: ElectronWindowShape["create"] = (options, onWindowOpenRequest) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new BrowserWindow(options),
      catch: (cause) => new ElectronWindowCreateError({ cause }),
    }),
    (window) =>
      Effect.sync(() => {
        if (isElectronWindowUsable(window)) window.destroy();
      }),
  ).pipe(
    Effect.tap((window) =>
      Effect.try({
        try: () => {
          electronRendererRegistry.register(window.webContents);
          guardRendererNavigation(window.webContents, onWindowOpenRequest);
        },
        catch: (cause) => new ElectronWindowCreateError({ cause }),
      }),
    ),
  );

const createHost: ElectronWindowShape["createHost"] = (options) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new BaseWindow(options),
      catch: (cause) => new ElectronWindowCreateError({ cause }),
    }),
    (window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) window.destroy();
      }),
  );

const createView: ElectronWindowShape["createView"] = (
  options,
  onWindowOpenRequest,
) =>
  Effect.try({
    try: (): ElectronGameViewHandle => {
      const view = new WebContentsView(options);
      const webContents = view.webContents;
      return {
        native: view,
        // The native view clears its accessor after close; retain the contents for cleanup observers.
        webContents,
        getBounds: () => view.getBounds(),
        setBounds: (bounds) => view.setBounds(bounds),
        setBackgroundColor: (color) => view.setBackgroundColor(color),
      };
    },
    catch: (cause) => new ElectronWindowCreateError({ cause }),
  }).pipe(
    (acquire) =>
      Effect.acquireRelease(acquire, (view) =>
        Effect.sync(() => {
          if (!view.webContents.isDestroyed()) {
            view.webContents.close({ waitForBeforeUnload: false });
          }
        }),
      ),
    Effect.tap((view) =>
      Effect.try({
        try: () => {
          electronRendererRegistry.register(view.webContents);
          guardRendererNavigation(view.webContents, onWindowOpenRequest);
        },
        catch: (cause) => new ElectronWindowCreateError({ cause }),
      }),
    ),
  );

const loadFile: ElectronWindowShape["loadFile"] = (
  webContents,
  path,
  options,
) =>
  Effect.tryPromise({
    try: () => webContents.loadFile(path, options),
    catch: (cause) => new ElectronWindowLoadError({ cause, path }),
  });

const reveal: ElectronWindowShape["reveal"] = (window) =>
  Effect.sync(() => {
    if (!isElectronWindowUsable(window)) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    if (!window.isVisible()) {
      window.show();
    }

    window.focus();
  });

export const layer = Layer.succeed(
  ElectronWindow,
  ElectronWindow.of({
    create,
    createHost,
    createView,
    loadFile,
    reveal,
  }),
);
