import { app } from "electron";
import * as Effect from "effect/Effect";

import { makeDesktopLayer, makeDesktopObservabilityLayer } from "./app/Layers";
import { makeDesktopRuntime } from "./app/DesktopRuntime";
import { prepareMainProcess } from "./app/Preflight";
import { layer as electronAppLayer } from "./electron/ElectronApp";

const { cliOptions, envConfig } = prepareMainProcess();

if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.exit(0);
} else {
  void Effect.runPromise(
    makeDesktopRuntime(
      cliOptions,
      makeDesktopLayer(),
      makeDesktopObservabilityLayer(envConfig),
    ).pipe(Effect.provide(electronAppLayer)),
  ).then(
    (exitCode) => {
      app.exit(exitCode);
    },
    (cause: unknown) => {
      console.error("Lucent desktop runtime failed.", cause);
      app.exit(1);
    },
  );
}
