import { app } from "electron";
import * as Effect from "effect/Effect";

import { makeDesktopLayer } from "./app/Layers";
import { makeDesktopRuntime } from "./app/DesktopRuntime";
import { prepareMainProcess } from "./app/Preflight";

const { cliOptions, envConfig } = prepareMainProcess();

void Effect.runPromise(
  makeDesktopRuntime(cliOptions, makeDesktopLayer(envConfig)),
).then(
  () => {
    app.exit(0);
  },
  (cause: unknown) => {
    console.error("Lucent desktop runtime failed.", cause);
    app.exit(1);
  },
);
