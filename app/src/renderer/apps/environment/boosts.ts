import type { EnvironmentBankBoost } from "../../../shared/environmentBoosts";

const normalizedName = (name: string): string => name.trim().toLowerCase();

export const prepareEnvironmentBankBoosts = (
  candidates: readonly EnvironmentBankBoost[],
): readonly EnvironmentBankBoost[] => {
  const seenNames = new Set<string>();
  return candidates
    .flatMap((candidate) => {
      const name = candidate.name.trim();
      const key = normalizedName(name);
      if (key === "" || seenNames.has(key)) {
        return [];
      }
      seenNames.add(key);
      return [{ ...candidate, name }];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
};

export const environmentBoostWithdrawalSummary = (
  requested: number,
  withdrawn: number,
): string => {
  const failed = Math.max(0, requested - withdrawn);
  if (failed === 0) return "";
  if (withdrawn === 0) {
    return `Couldn't withdraw ${failed} ${failed === 1 ? "boost" : "boosts"}. Try again.`;
  }
  return `Withdrew ${withdrawn} ${withdrawn === 1 ? "boost" : "boosts"}. Couldn't withdraw ${failed}.`;
};
