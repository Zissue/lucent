import { LiveModel } from "./model";

export type AuraKind = "active" | "passive";

export interface AuraQueryOptions {
  readonly kind?: AuraKind;
}

export interface Aura {
  readonly category: string | undefined;
  readonly duration: number;
  readonly expiresAt: number | undefined;
  readonly icon: string | undefined;
  readonly kind: AuraKind;
  readonly name: string;
  readonly persistent: boolean;
  readonly stack: number;
  readonly value: number | string | undefined;
  toJSON(): AuraSnapshot;
}

export interface AuraData {
  category?: string;
  duration: number;
  expiresAt?: number;
  icon?: string;
  kind: AuraKind;
  name: string;
  persistent: boolean;
  stack: number;
  value?: number | string;
}

export type AuraSnapshot = Readonly<AuraData>;

export class LiveAura extends LiveModel<AuraData> implements Aura {
  get category(): string | undefined {
    return this.modelData.category;
  }
  /** Full duration in seconds, or `0` when the aura has no timer. */
  get duration(): number {
    return this.modelData.duration;
  }
  /** Expiry time in epoch milliseconds, or `undefined` when the aura has no timer. The aura stays until the server removes it, even after this time. */
  get expiresAt(): number | undefined {
    return this.modelData.expiresAt;
  }
  get icon(): string | undefined {
    return this.modelData.icon;
  }
  get kind(): AuraKind {
    return this.modelData.kind;
  }
  get name(): string {
    return this.modelData.name;
  }
  get persistent(): boolean {
    return this.modelData.persistent;
  }
  get stack(): number {
    return this.modelData.stack;
  }
  get value(): number | string | undefined {
    return this.modelData.value;
  }
  toJSON(): AuraSnapshot {
    return this.snapshot();
  }
}

/** @internal */
export type AuraTiming =
  | { readonly type: "untimed" }
  | { readonly type: "seconds"; readonly duration: number };

/** @internal */
export interface AuraApplication {
  readonly name: string;
  readonly stack: number;
  readonly timing: AuraTiming;
  readonly persistent: boolean;
  readonly restartDuration: boolean;
  readonly icon?: string;
  readonly category?: string;
  readonly value?: number | string;
}

/** @internal */
export interface AuraSeed {
  readonly name: string;
  readonly icon: string;
  readonly stack: number;
  readonly persistent: boolean;
  readonly timer:
    | { readonly type: "untimed" }
    | {
        readonly type: "timed";
        readonly remainingSeconds: number;
        readonly fullSeconds: number;
      };
}

/** @internal */
export type AuraWithdrawal =
  | { readonly type: "remove"; readonly name: string }
  | {
      readonly type: "decay";
      readonly name: string;
      readonly stack: number;
      readonly refreshSeconds?: number;
    };

/** @internal */
export interface PassiveAuraInput {
  readonly name: string;
  readonly category?: string;
  readonly icon?: string;
  readonly value?: number | string;
  readonly duration: number;
}

/** @internal */
export type AuraMutation =
  | { readonly type: "seed"; readonly entries: readonly AuraSeed[] }
  | { readonly type: "apply"; readonly entries: readonly AuraApplication[] }
  | { readonly type: "withdraw"; readonly entries: readonly AuraWithdrawal[] }
  | {
      readonly type: "set-stack";
      readonly entries: readonly {
        readonly name: string;
        readonly stack: number;
      }[];
    }
  | {
      readonly type: "passives";
      readonly mode: "replace" | "merge";
      readonly entries: readonly PassiveAuraInput[];
    }
  | { readonly type: "clear"; readonly keepPersistent: boolean };

/** @internal */
export type AuraDelta =
  | { readonly type: "added"; readonly after: AuraSnapshot }
  | {
      readonly type: "updated";
      readonly before: AuraSnapshot;
      readonly after: AuraSnapshot;
    }
  | { readonly type: "removed"; readonly before: AuraSnapshot };

/** @internal */
export type ActiveAuraEdit =
  | { readonly type: "seed"; readonly entry: AuraSeed }
  | { readonly type: "apply"; readonly entry: AuraApplication }
  | AuraWithdrawal
  | {
      readonly type: "set-stack";
      readonly name: string;
      readonly stack: number;
    };

/** @internal */
export function reduceActiveAura(
  before: AuraSnapshot | undefined,
  edit: ActiveAuraEdit,
  nowMs: number,
): AuraSnapshot | undefined {
  switch (edit.type) {
    case "seed": {
      const { entry } = edit;
      return {
        ...(before?.category === undefined
          ? {}
          : { category: before.category }),
        ...(before?.value === undefined ? {} : { value: before.value }),
        name: entry.name,
        kind: "active",
        stack: Math.max(1, entry.stack),
        icon: entry.icon,
        persistent: entry.persistent,
        ...(entry.timer.type === "untimed"
          ? { duration: 0 }
          : {
              duration: Math.max(
                entry.timer.fullSeconds,
                entry.timer.remainingSeconds,
              ),
              expiresAt: nowMs + entry.timer.remainingSeconds * 1_000,
            }),
      };
    }
    case "apply": {
      const { entry } = edit;
      const next: AuraData = {
        ...before,
        name: entry.name,
        kind: "active",
        stack: entry.stack,
        persistent: entry.persistent,
        duration: 0,
      };
      if (entry.icon !== undefined) next.icon = entry.icon;
      if (entry.category !== undefined) next.category = entry.category;
      if (entry.value !== undefined) next.value = entry.value;
      if (entry.timing.type === "seconds") {
        next.duration = entry.restartDuration
          ? entry.timing.duration
          : Math.max(before?.duration ?? 0, entry.timing.duration);
        next.expiresAt = nowMs + entry.timing.duration * 1_000;
      } else {
        delete next.expiresAt;
      }
      return next;
    }
    case "remove":
      return undefined;
    case "decay": {
      if (before === undefined) return undefined;
      const next: AuraData = { ...before, stack: edit.stack };
      if (edit.refreshSeconds !== undefined && before.expiresAt !== undefined) {
        next.duration = Math.max(before.duration, edit.refreshSeconds);
        next.expiresAt = nowMs + edit.refreshSeconds * 1_000;
      }
      return next;
    }
    case "set-stack":
      return before === undefined
        ? undefined
        : { ...before, stack: Math.max(1, edit.stack) };
  }
}
