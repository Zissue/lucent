import type { AccountLaunchWindowTarget } from "@lucent/core/accounts";

export type AccountLaunchMode = "standard" | "auto-grid";

export function resolveAccountLaunchWindowTarget(
  newWindow: boolean,
  firstGameWindowId: number | undefined,
): AccountLaunchWindowTarget | undefined {
  if (!newWindow) return undefined;
  return firstGameWindowId === undefined
    ? { kind: "new" }
    : { gameWindowId: firstGameWindowId, kind: "same-as-game" };
}
