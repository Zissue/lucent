import type {
  DesktopRendererKindSchema,
  DesktopWindowKindSchema,
} from "../../shared/ipc/windows";

export type DesktopWindowKind = typeof DesktopWindowKindSchema.Type;
export type DesktopRendererKind = typeof DesktopRendererKindSchema.Type;
export type DesktopWindowCloseBehavior = "destroy" | "hide";
export type DesktopWindowScope = "application" | "game" | "game-child";

export interface DesktopWindowDefinition {
  readonly closeBehavior: DesktopWindowCloseBehavior;
  readonly height: number;
  readonly kind: DesktopWindowKind;
  readonly minHeight?: number;
  readonly minWidth?: number;
  readonly fixedSize?: boolean;
  readonly scope: DesktopWindowScope;
  readonly singleInstance: boolean;
  readonly width: number;
}

const desktopWindowCatalog: ReadonlyMap<
  DesktopWindowKind,
  DesktopWindowDefinition
> = new Map([
  [
    "game",
    {
      kind: "game",
      width: 1024,
      height: 768,
      closeBehavior: "destroy",
      scope: "game",
      singleInstance: false,
    },
  ],
  [
    "settings",
    {
      kind: "settings",
      width: 651,
      height: 654,
      closeBehavior: "hide",
      scope: "application",
      singleInstance: true,
    },
  ],
  [
    "about",
    {
      kind: "about",
      width: 360,
      height: 300,
      closeBehavior: "destroy",
      fixedSize: true,
      scope: "application",
      singleInstance: true,
    },
  ],
  [
    "account-manager",
    {
      kind: "account-manager",
      width: 980,
      height: 720,
      closeBehavior: "hide",
      scope: "application",
      singleInstance: true,
    },
  ],
  [
    "combat-profiles",
    {
      kind: "combat-profiles",
      width: 760,
      height: 560,
      minWidth: 560,
      minHeight: 460,
      closeBehavior: "hide",
      scope: "application",
      singleInstance: true,
    },
  ],
  [
    "environment",
    {
      kind: "environment",
      width: 778,
      height: 613,
      closeBehavior: "hide",
      scope: "game-child",
      singleInstance: true,
    },
  ],
  [
    "follower",
    {
      kind: "follower",
      width: 648,
      height: 496,
      minWidth: 1,
      minHeight: 1,
      closeBehavior: "hide",
      scope: "game-child",
      singleInstance: true,
    },
  ],
  [
    "loader-grabber",
    {
      kind: "loader-grabber",
      width: 712,
      height: 710,
      minWidth: 500,
      minHeight: 480,
      closeBehavior: "hide",
      scope: "game-child",
      singleInstance: true,
    },
  ],
  [
    "packets",
    {
      kind: "packets",
      width: 620,
      height: 483,
      closeBehavior: "hide",
      scope: "game-child",
      singleInstance: true,
    },
  ],
]);

export const getDesktopWindowDefinition = (
  kind: DesktopWindowKind,
): DesktopWindowDefinition => {
  const definition = desktopWindowCatalog.get(kind);
  if (definition === undefined) {
    throw new Error(`Unknown desktop window kind: ${kind}`);
  }

  return definition;
};
