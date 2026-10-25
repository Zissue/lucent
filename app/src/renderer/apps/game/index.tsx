import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { mountDesktopRenderer } from "../../RendererBootstrap";
import { App } from "./App";
import { followerRpcHandlers } from "./automation/Automation";
import { environmentRpcHandlers } from "./environment/Environment";
import { flashRuntime } from "./flash";
import { installConsoleForwarder } from "./consoleForwarder";
import { serveGameRendererRpc } from "./gameRendererRpc";
import { loaderGrabberRpcHandlers } from "./loaderGrabber";
import { installPacketsBridge, makePacketsRpcHandlers } from "./packetsBridge";
import { selectDesktopBridge } from "../../../shared/desktopBridge";
import { mountRufflePlayer } from "./ruffle";

void mountRufflePlayer().catch((cause) => {
  console.error("[ruffle] failed to start the game", cause);
});

const desktop = selectDesktopBridge(window.desktop, "game");

installConsoleForwarder(desktop.gameConsoleObservability);
const packetsBridge = installPacketsBridge(flashRuntime, desktop.packets);
const gameRendererRpcListening = Promise.withResolvers<void>();
const gameRendererRpc = flashRuntime.runFork(
  serveGameRendererRpc(
    Layer.mergeAll(
      environmentRpcHandlers,
      followerRpcHandlers,
      loaderGrabberRpcHandlers,
      makePacketsRpcHandlers(packetsBridge),
    ),
    gameRendererRpcListening.resolve,
  ),
);
const groupCommandReceiverReady = Promise.withResolvers<void>();

void Promise.all([
  flashRuntime.context(),
  groupCommandReceiverReady.promise,
  gameRendererRpcListening.promise,
])
  .then(() => {
    performance.mark("lucent.game.flash-runtime-ready");
    return desktop.gameRenderer.ready();
  })
  .then(() => {
    performance.mark("lucent.game.renderer-ready-reported");
  })
  .catch((cause) => {
    console.warn("[flash] runtime initialization failed", cause);
  });

mountDesktopRenderer(
  (props) => (
    <App
      {...props}
      onGroupCommandReceiverReady={groupCommandReceiverReady.resolve}
    />
  ),
  {
    cleanup: () => {
      flashRuntime.runFork(Fiber.interrupt(gameRendererRpc));
      packetsBridge.dispose();
      void flashRuntime.dispose();
    },
    markReady: false,
  },
);
