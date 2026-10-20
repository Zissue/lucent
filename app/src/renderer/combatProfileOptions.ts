import type { CombatProfile } from "@lucent/core/combatProfiles";

export type ProfileSummary = Pick<CombatProfile, "id" | "label" | "classNames">;

export interface CombatProfileOption extends ProfileSummary {
  readonly classNames: readonly string[];
  readonly disabled: boolean;
  readonly group?: string;
  readonly searchText: string | undefined;
  readonly value: string;
}

/** Class aliases get distinct option values so keyboard navigation can visit each row. */
export function buildCombatProfileOptions(
  profiles: readonly ProfileSummary[],
  grouped: boolean,
  disabled = false,
) {
  const items: CombatProfileOption[] = profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    classNames: profile.classNames ?? [],
    disabled,
    searchText: profile.classNames?.join(" "),
    value: profile.id,
  }));
  if (!grouped) return items;

  const groups = new Map<string, { label: string; items: typeof items }>();
  for (const item of items) {
    const classNames = new Map<string, string>();
    for (const name of item.classNames) {
      const key = name.trim().toLocaleLowerCase();
      if (key !== "" && !classNames.has(key)) classNames.set(key, name.trim());
    }
    if (classNames.size === 0) classNames.set("", "Any class");

    for (const [key, label] of classNames) {
      let group = groups.get(key);
      if (group === undefined) {
        group = { label, items: [] };
        groups.set(key, group);
      }
      group.items.push({
        ...item,
        group: group.label,
        searchText: group.label,
        value: JSON.stringify([key, item.id]),
      });
    }
  }

  return [...groups.entries()]
    .toSorted(([leftKey, left], [rightKey, right]) =>
      leftKey === ""
        ? -1
        : rightKey === ""
          ? 1
          : left.label.localeCompare(right.label),
    )
    .flatMap(([, group]) => group.items);
}

/** Keeps the chosen alias selected without changing the underlying profile ID. */
export function resolveCombatProfileOptionValue(
  options: readonly CombatProfileOption[],
  profileId: string,
  preferredValue: string,
): string {
  let firstValue = "";
  for (const option of options) {
    if (option.id !== profileId) continue;
    if (option.value === preferredValue) return option.value;
    if (firstValue === "") firstValue = option.value;
  }
  return firstValue;
}
