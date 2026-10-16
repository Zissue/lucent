import type { EnvironmentQuestRegistration } from "@lucent/core/environment";

export const splitEnvironmentBulkInput = (value: string): string[] =>
  value
    .split(";")
    .map((token) => token.trim())
    .filter(Boolean);

const parsePositiveInt = (value: string): number | undefined => {
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const parseQuestToken = (
  token: string,
): EnvironmentQuestRegistration | null => {
  const [questText = "", rewardText = "", ...rest] = token.split(":");
  const questId = parsePositiveInt(questText);
  if (questId === undefined || rest.length > 0) {
    return null;
  }
  if (rewardText.trim() === "") {
    return { questId };
  }
  const rewardItemId = parsePositiveInt(rewardText);
  return rewardItemId === undefined ? null : { questId, rewardItemId };
};

export const parseEnvironmentQuestBulkInput = (
  value: string,
): readonly EnvironmentQuestRegistration[] | null => {
  const quests = splitEnvironmentBulkInput(value).map(parseQuestToken);
  return quests.every((quest) => quest !== null) ? quests : null;
};
