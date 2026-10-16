import type { LiveItem } from "@lucent/game";
import * as Effect from "effect/Effect";

import type {
  EnvironmentBankBoost,
  EnvironmentBoostDiscovery,
} from "../../../../shared/environmentBoosts";
import { logFailure } from "../../../../shared/logFailure";
import type { ApiService } from "../flash/api/Api";

export interface EnvironmentBoostApi {
  readonly bank: Pick<
    ApiService["bank"],
    "get" | "getAll" | "open" | "withdraw"
  >;
  readonly inventory: Pick<ApiService["inventory"], "get" | "getAll">;
}

const normalizedName = (name: string): string => name.trim().toLowerCase();

const inventoryBoostNames = (items: readonly LiveItem[]): readonly string[] => {
  const names = new Map<string, string>();
  for (const item of items) {
    if (item.category !== "ServerUse") continue;
    const key = normalizedName(item.name);
    if (key !== "" && !names.has(key)) {
      names.set(key, item.name.trim());
    }
  }
  return Array.from(names.values());
};

const bankBoosts = (
  items: readonly LiveItem[],
  inventoryNames: readonly string[],
): readonly EnvironmentBankBoost[] => {
  const unavailableNames = new Set(inventoryNames.map(normalizedName));
  const candidates = new Map<string, EnvironmentBankBoost>();
  for (const item of items) {
    if (item.category !== "ServerUse") continue;
    const name = item.name.trim();
    const key = normalizedName(name);
    if (key === "" || unavailableNames.has(key) || candidates.has(key)) {
      continue;
    }
    candidates.set(key, {
      itemId: item.itemId,
      name,
      quantity: Math.max(1, item.quantity),
    });
  }
  return Array.from(candidates.values());
};

export const discoverEnvironmentBoosts = Effect.fn(
  "Environment.discoverBoosts",
)(function* (
  api: EnvironmentBoostApi,
): Effect.fn.Return<EnvironmentBoostDiscovery> {
  const inventory = inventoryBoostNames(yield* api.inventory.getAll());
  const bankResult = yield* Effect.gen(function* () {
    if (!(yield* api.bank.open())) {
      return { items: [] as readonly LiveItem[], loaded: false };
    }
    return { items: yield* api.bank.getAll(), loaded: true };
  }).pipe(
    Effect.catchCause((cause) =>
      logFailure(
        "Failed to load bank boosts for Environment discovery",
        cause,
        {
          failure: "warning",
        },
      ).pipe(
        Effect.annotateLogs({ component: "environment" }),
        Effect.as({ items: [] as readonly LiveItem[], loaded: false }),
      ),
    ),
  );

  return {
    bank: bankBoosts(bankResult.items, inventory),
    bankLoaded: bankResult.loaded,
    inventory,
  };
});

export const withdrawEnvironmentBoosts = Effect.fn(
  "Environment.withdrawBoosts",
)(function* (
  api: EnvironmentBoostApi,
  itemIds: readonly number[],
): Effect.fn.Return<readonly number[]> {
  const withdrawnItemIds: number[] = [];
  for (const itemId of new Set(itemIds)) {
    const alreadyAvailable = yield* api.inventory
      .get(itemId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (alreadyAvailable?.category === "ServerUse") {
      withdrawnItemIds.push(itemId);
      continue;
    }

    const bankItem = yield* api.bank
      .get(itemId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (bankItem?.category !== "ServerUse") {
      continue;
    }

    const withdrawn = yield* api.bank.withdraw(itemId).pipe(
      Effect.catchCause((cause) =>
        logFailure("Failed to withdraw an Environment boost", cause, {
          failure: "warning",
        }).pipe(
          Effect.annotateLogs({ component: "environment", data: { itemId } }),
          Effect.as(false),
        ),
      ),
    );
    if (withdrawn) {
      withdrawnItemIds.push(itemId);
    }
  }
  return withdrawnItemIds;
});
