import type { EnvironmentState } from "@lucent/core/environment";

type EnvironmentRequest = () => Promise<EnvironmentState>;

export const renameEntry = async (
  update: (request: EnvironmentRequest) => Promise<EnvironmentState | null>,
  from: string,
  to: string,
  requests: {
    readonly add: EnvironmentRequest;
    readonly remove: EnvironmentRequest;
  },
): Promise<boolean> => {
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  const order = caseOnly
    ? [requests.remove, requests.add]
    : [requests.add, requests.remove];
  for (const request of order) {
    if ((await update(request)) === null) {
      return false;
    }
  }
  return true;
};
