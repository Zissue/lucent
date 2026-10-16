import { parseArgs } from "node:util";

import { isAppLaunchMode, type AppLaunchMode } from "@lucent/core/settings";

export interface CliOptions {
  readonly debug?: boolean;
  readonly launchMode?: AppLaunchMode;
}

export const parseCliOptions = (argv: readonly string[]): CliOptions => {
  const { tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const output: {
    debug?: boolean;
    launchMode?: AppLaunchMode;
  } = {};

  for (const token of tokens) {
    if (token.kind !== "option") continue;

    if (token.name === "debug" && token.value === undefined) {
      output.debug = true;
    } else if (token.name === "launch-mode" || token.name === "launchMode") {
      const value = (token.value ?? argv[token.index + 1])
        ?.trim()
        .toLowerCase();
      const launchMode = value === "manager" ? "account-manager" : value;
      if (isAppLaunchMode(launchMode)) output.launchMode = launchMode;
    }
  }

  return output;
};
