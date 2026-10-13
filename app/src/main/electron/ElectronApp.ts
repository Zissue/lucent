import { app, type ProcessMetric } from "electron";
import type { EventEmitter } from "node:events";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ElectronWillQuitEvent {
  readonly preventDefault: () => void;
}

export interface ElectronAppListeners {
  readonly activate: () => void;
  readonly "before-quit": () => void;
  readonly "will-quit": (event: ElectronWillQuitEvent) => void;
  readonly "window-all-closed": () => void;
}

export interface ElectronAppShape {
  readonly exit: (code?: number) => Effect.Effect<void>;
  readonly getAppMetrics: Effect.Effect<readonly ProcessMetric[]>;
  readonly getVersion: Effect.Effect<string>;
  readonly on: <EventName extends keyof ElectronAppListeners>(
    eventName: EventName,
    listener: ElectronAppListeners[EventName],
  ) => Effect.Effect<() => void>;
  readonly relaunch: Effect.Effect<void>;
  readonly quit: Effect.Effect<void>;
  readonly whenReady: Effect.Effect<void>;
}

export class ElectronApp extends Context.Service<
  ElectronApp,
  ElectronAppShape
>()("lucent/desktop/electron/ElectronApp") {}

export const layer = Layer.succeed(ElectronApp, {
  exit: (code) => Effect.sync(() => app.exit(code)),
  getAppMetrics: Effect.sync(() => app.getAppMetrics()),
  getVersion: Effect.sync(() => app.getVersion()),
  on: (event, listener) =>
    Effect.sync(() => {
      const events: EventEmitter = app;
      events.on(event, listener);
      return () => {
        events.removeListener(event, listener);
      };
    }),
  relaunch: Effect.sync(() => app.relaunch()),
  quit: Effect.sync(() => app.quit()),
  whenReady: Effect.promise(() => app.whenReady()).pipe(Effect.asVoid),
});
