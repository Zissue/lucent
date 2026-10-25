import type { EnvironmentBankBoost } from "../../../shared/environmentBoosts";

export interface EnvironmentBankBoostOption extends EnvironmentBankBoost {
  readonly alreadyAdded: boolean;
}

const normalizedName = (name: string): string => name.trim().toLowerCase();

export const prepareEnvironmentBankBoosts = (
  candidates: readonly EnvironmentBankBoost[],
  registeredBoosts: readonly string[],
): readonly EnvironmentBankBoostOption[] => {
  const registeredNames = new Set(registeredBoosts.map(normalizedName));
  const seenNames = new Set<string>();
  return candidates
    .flatMap((candidate) => {
      const name = candidate.name.trim();
      const key = normalizedName(name);
      if (key === "" || seenNames.has(key)) {
        return [];
      }
      seenNames.add(key);
      return [
        {
          alreadyAdded: registeredNames.has(key),
          itemId: candidate.itemId,
          name,
          quantity: candidate.quantity,
        },
      ];
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
    return `Could not withdraw ${failed} selected ${failed === 1 ? "boost" : "boosts"}.`;
  }
  return `Withdrew ${withdrawn} ${withdrawn === 1 ? "boost" : "boosts"}; ${failed} could not be withdrawn.`;
};
