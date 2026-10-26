import "../runtime/loop";
import "../runtime/web";
import "./node/globals";

import { host } from "../runtime/host";

export interface HubConfig {
  readonly appDataDir: string;
  readonly assetsDir: string;
  readonly debug: boolean;
  readonly home: string;
  readonly isDev: boolean;
  readonly platform: "darwin" | "linux" | "win32";
  readonly temp: string;
  readonly workspaceDir: string;
}

export const config = JSON.parse(String(host().call("config"))) as HubConfig;

Object.assign(globalThis, {
  __paths: { home: config.home, temp: config.temp },
});
Object.assign(Reflect.get(globalThis, "process") as object, {
  platform: config.platform,
});
