import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { ElectronApp } from "../../main/electron/ElectronApp";
import { ElectronDialog } from "../../main/electron/ElectronDialog";
import { ElectronShell } from "../../main/electron/ElectronShell";
import { GameRendererRpc } from "../../main/game/rpc/GameRendererRpc";
import { DesktopIpc, makeDesktopIpc } from "../../main/ipc/DesktopIpc";
import { ScriptPackageManager } from "../../main/scripting/ScriptPackageManager";
import {
  DesktopWindowError,
  DesktopWindows,
  type CloseableRendererLifetime,
  type DesktopRendererEvent,
  type DesktopRendererInfo,
  type DesktopWindowsShape,
} from "../../main/window/DesktopWindows";
import type { IpcInvokeEnvelope } from "../../shared/ipc";
import { host } from "../runtime/host";
declare const __LUCENT_VERSION__: string;

/** Electron's `app.getVersion()`, which package compatibility ranges are checked against. */
const version = __LUCENT_VERSION__;

type InvokeListener = (
  event: { readonly sender: { readonly id: number } },
  payload: unknown,
) => Promise<IpcInvokeEnvelope<unknown>>;

/** Channel handlers that main's `DesktopIpc.handle` registered. */
export const handlers = new Map<string, InvokeListener>();

interface Account {
  readonly info: DesktopRendererInfo;
  readonly lifetime: CloseableRendererLifetime;
  current: boolean;
}

const accounts = new Map<number, Account>();
const observers = new Set<{
  readonly kind?: string;
  readonly listener: (
    event: DesktopRendererEvent,
  ) => Effect.Effect<void, unknown>;
}>();

const notify = (event: DesktopRendererEvent): void => {
  for (const observer of observers) {
    if (observer.kind !== undefined && observer.kind !== event.kind) continue;
    Effect.runFork(observer.listener(event).pipe(Effect.ignore));
  }
};

/** Every invoke comes from an account; the first one registers it. */
export const touchAccount = (rendererId: number): void => {
  if (accounts.has(rendererId)) return;
  const lifetime: CloseableRendererLifetime = {
    rendererId,
    generation: 1,
    scope: Scope.makeUnsafe(),
    isCurrent: () => accounts.get(rendererId)?.current === true,
  };
  accounts.set(rendererId, {
    lifetime,
    current: true,
    info: {
      rendererId,
      kind: "game",
      windowId: rendererId,
      ownerId: undefined,
      lifetime,
      ready: true,
    },
  });
  notify({ rendererId, kind: "game", generation: 1, type: "created" });
};

/** The account runtime with `rendererId` is gone (closed, or restarted after a crash). */
export const closeAccount = (
  rendererId: number,
  type: "closed" | "reloaded",
): void => {
  const account = accounts.get(rendererId);
  if (account === undefined) return;
  account.current = false;
  accounts.delete(rendererId);
  notify({ rendererId, kind: "game", generation: 1, type });
  Effect.runFork(Scope.close(account.lifetime.scope, Exit.void));
};

const unavailable = (what: string) =>
  Effect.fail(
    new DesktopWindowError({
      detail: `${what} is not available in the native app`,
    } as never),
  );

const windows: DesktopWindowsShape = {
  updateGameViewHost: () => unavailable("Game view hosts"),
  closeRenderer: () => Effect.succeed(false),
  getRendererIds: (kind) =>
    Effect.sync(() => (kind === "game" ? [...accounts.keys()] : [])),
  describe: (rendererId) => Effect.sync(() => accounts.get(rendererId)?.info),
  getVisibleParentWindowId: Effect.succeed(undefined),
  isVisibleParentWindow: () => Effect.succeed(false),
  getOwnedRendererIds: () => Effect.succeed([]),
  markRendererReady: () => Effect.void,
  addGameView: () => unavailable("Game view hosts"),
  closeGameView: () => unavailable("Game view hosts"),
  getGameViewHostState: () => unavailable("Game view hosts"),
  getGameViewPresentation: () => unavailable("Game view presentation"),
  observe: (filter, listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const observer = {
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          listener,
        };
        observers.add(observer);
        return observer;
      }),
      (observer) => Effect.sync(() => observers.delete(observer)),
    ).pipe(Effect.asVoid),
  open: () => unavailable("Windows"),
  revealRenderer: () => Effect.succeed(false),
  reloadFocusedGameContents: () => Effect.succeed(false),
  setBackgroundColor: () => Effect.void,
  setGameViewName: () => Effect.void,
  withGameViewGroupControlsNativeDialog: () => unavailable("Group controls"),
};

const ipc = makeDesktopIpc(
  {
    handle: (channel, listener) => {
      handlers.set(channel, listener as unknown as InvokeListener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  },
  {
    getAllWebContents: () =>
      [...accounts.keys()].map((rendererId) => ({
        isDestroyed: () => !accounts.has(rendererId),
        send: (channel: string, payload: unknown) =>
          void host().call(
            "emit",
            rendererId,
            channel,
            JSON.stringify(payload ?? null),
          ),
      })),
    fromId: (rendererId) =>
      accounts.has(rendererId)
        ? {
            isDestroyed: () => !accounts.has(rendererId),
            send: (channel: string, payload: unknown) =>
              void host().call(
                "emit",
                rendererId,
                channel,
                JSON.stringify(payload ?? null),
              ),
          }
        : undefined,
  },
);

const shell = ElectronShell.of({
  openExternal: (url) =>
    Effect.sync(() => host().call("open", url.href) === true),
  openPath: (path) => Effect.sync(() => host().call("open", path) === true),
  showItemInFolder: (path) =>
    Effect.sync(() => void host().call("reveal", path)),
});

const dialog = ElectronDialog.of({
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showOpenDialog: () => Effect.succeed({ canceled: true, filePaths: [] }),
});

const app = ElectronApp.of({
  exit: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  getVersion: Effect.succeed(version),
  on: () => Effect.void,
  relaunch: Effect.void,
  quit: Effect.void,
  whenReady: Effect.void,
});

/** Fails every call: the windows and package flows that use it are outside the native MVP. */
const unavailableService = <S extends object>(name: string): S =>
  new Proxy({} as S, {
    get: (_target, key) =>
      key === "then"
        ? undefined
        : () =>
            Effect.die(
              new Error(
                `${name}.${String(key)} is not available in the native app`,
              ),
            ),
  });

export const platformLayer = Layer.mergeAll(
  Layer.succeed(DesktopWindows, DesktopWindows.of(windows)),
  Layer.succeed(DesktopIpc, ipc),
  Layer.succeed(ElectronApp, app),
  Layer.succeed(ElectronShell, shell),
  Layer.succeed(ElectronDialog, dialog),
  Layer.succeed(
    GameRendererRpc,
    unavailableService<GameRendererRpc["Service"]>("GameRendererRpc"),
  ),
  Layer.succeed(
    ScriptPackageManager,
    unavailableService<ScriptPackageManager["Service"]>("ScriptPackageManager"),
  ),
);
