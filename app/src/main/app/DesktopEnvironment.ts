import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export interface DesktopEnvironmentConfig {
  readonly appDataDir: string;
  readonly assetsDir: string;
  readonly debug?: boolean;
  readonly isDev: boolean;
  readonly platform: NodeJS.Platform;
  readonly workspaceDir: string;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  DesktopEnvironmentConfig
>()("lucent/desktop/app/DesktopEnvironment") {}

export const layer = (config: DesktopEnvironmentConfig) =>
  Layer.succeed(DesktopEnvironment, DesktopEnvironment.of(config));
