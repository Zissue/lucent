/** @jsxImportSource react */
import { mountReactRenderer } from "../../ReactRendererBootstrap";
import { App } from "./App";

mountReactRenderer({
  app: (settings) => (
    <App initialSettings={settings} platform={window.desktop.platform.os} />
  ),
});
