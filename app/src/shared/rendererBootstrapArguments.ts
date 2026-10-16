import type { GameViewLayout } from "./gameViews";

export const DEBUG_MODE_ARGUMENT = "--lucent__debug";
export const GAME_CONSOLE_OBSERVABILITY_ARGUMENT =
  "--lucent__gameConsoleObservability";
export const GAME_VIEW_LAYOUT_ARGUMENT = "--lucent__gameViewLayout";

export const readArgumentValue = (
  argv: readonly string[],
  name: string,
): string | null => {
  const prefix = `${name}=`;
  const value = argv.find((argument) => argument.startsWith(prefix));
  return value === undefined ? null : value.slice(prefix.length);
};

export const serializeGameViewLayoutArgument = (
  layout: GameViewLayout,
): string => `${GAME_VIEW_LAYOUT_ARGUMENT}=${layout}`;

export const readDebugModeArgument = (argv: readonly string[]): boolean =>
  argv.includes(DEBUG_MODE_ARGUMENT);

export const readGameConsoleObservabilityArgument = (
  argv: readonly string[],
): boolean => argv.includes(GAME_CONSOLE_OBSERVABILITY_ARGUMENT);

export const readGameViewLayoutArgument = (
  argv: readonly string[],
): GameViewLayout | null => {
  const value = readArgumentValue(argv, GAME_VIEW_LAYOUT_ARGUMENT);
  return value === "focused" || value === "grid" ? value : null;
};
