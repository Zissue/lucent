/** @jsxImportSource react */
import { mountReactRenderer } from "../../ReactRendererBootstrap";
import { App } from "./App";

mountReactRenderer({ app: () => <App />, markReady: false });
