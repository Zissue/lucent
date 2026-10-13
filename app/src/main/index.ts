import { app } from "electron";
import * as Effect from "effect/Effect";

import { makeDesktopRuntime } from "./app/DesktopRuntime";
import { prepareMainProcess } from "./app/Preflight";

void Effect.runPromise(makeDesktopRuntime(prepareMainProcess())).then(
  () => {
    app.exit(0);
  },
  (cause: unknown) => {
    console.error("Lucent desktop runtime failed.", cause);
    app.exit(1);
  },
);
