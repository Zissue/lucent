import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { AccountLaunchWindowTarget } from "@lucent/core/accounts";

export interface AccountGameWindowEvent {
  readonly gameWindowGroupId?: number;
  readonly gameWindowId: number;
  readonly rendererGeneration: number;
}

export interface AccountGameWindowsShape {
  readonly close: (gameWindowId: number) => Effect.Effect<boolean, unknown>;
  readonly getGeneration: (
    gameWindowId: number,
  ) => Effect.Effect<number, unknown>;
  readonly getGroupId: (gameWindowId: number) => Effect.Effect<number, unknown>;
  readonly onClosed: (
    listener: (gameWindowId: number) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly onCreated: (
    listener: (event: AccountGameWindowEvent) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly onReloaded: (
    listener: (event: AccountGameWindowEvent) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly open: (options?: {
    readonly gameViewLayout?: "grid";
    readonly managedProfileKey?: string;
    readonly name?: string;
    readonly onCreated?: (
      event: AccountGameWindowEvent,
    ) => Effect.Effect<void, unknown>;
    readonly windowTarget?: AccountLaunchWindowTarget;
  }) => Effect.Effect<number, unknown>;
  readonly reveal: (gameWindowId: number) => Effect.Effect<boolean, unknown>;
  readonly retireProfile: (key: string) => Effect.Effect<void, unknown>;
  readonly setName: (
    gameWindowId: number,
    name: string,
  ) => Effect.Effect<void, unknown>;
}

export class AccountGameWindows extends Context.Service<
  AccountGameWindows,
  AccountGameWindowsShape
>()("lucent/internal/accounts/AccountGameWindows") {}
