import { app } from "electron";
import * as Effect from "effect/Effect";

import { makeDesktopLayer } from "./app/Layers";
import { makeDesktopRuntime } from "./app/DesktopRuntime";
import { prepareMainProcess } from "./app/Preflight";
import { layer as electronAppLayer } from "./electron/ElectronApp";

const { cliOptions, envConfig } = prepareMainProcess();

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  void Effect.runPromise(
    makeDesktopRuntime(cliOptions, makeDesktopLayer(envConfig)).pipe(
      Effect.provide(electronAppLayer),
    ),
  ).then(
    () => {
      app.exit(0);
    },
    (cause: unknown) => {
      console.error("Lucent desktop runtime failed.", cause);
      app.exit(1);
    },
  );
}
