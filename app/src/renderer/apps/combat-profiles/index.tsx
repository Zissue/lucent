import { mountRenderer } from "../../RendererBootstrap";
import { App } from "./App";

mountRenderer({ app: () => <App /> });
