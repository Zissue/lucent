import { describe, expect, it } from "@effect/vitest";
import * as Scope from "effect/Scope";

import type { GameViewPresentation } from "../../shared/gameViews";
import type { ElectronGameViewHandle } from "../electron/ElectronWindow";
import type { ElectronNativeWindowHandle } from "../electron/ElectronWindow";
import {
  makeDesktopGameHosts,
  parseGameViewTabId,
  type DesktopGameHostRecord,
  type DesktopGameViewRecord,
} from "./DesktopGameHost";

interface Bounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const makeView = (
  onPresentation: (presentation: GameViewPresentation) => void = () => {},
) => {
  let bounds: Bounds = { height: 0, width: 0, x: 0, y: 0 };
  const view = {
    native: {},
    webContents: {
      focus: () => {},
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      send: (_channel: string, presentation: GameViewPresentation) =>
        onPresentation(presentation),
    },
    getBounds: () => bounds,
    setBounds: (next: Bounds) => {
      bounds = next;
    },
    setBackgroundColor: () => {},
  };
  return view as unknown as ElectronGameViewHandle;
};

const makeHost = (ids: readonly number[]) => {
  let content = { height: 830, width: 1200, x: 0, y: 0 };
  const window = {
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    getContentBounds: () => content,
    isDestroyed: () => false,
    isFocused: () => true,
  } as unknown as ElectronNativeWindowHandle;
  const presentations = new Map<number, GameViewPresentation[]>();
  const records = new Map<number, DesktopGameViewRecord>();
  for (const id of ids) {
    const sent: GameViewPresentation[] = [];
    presentations.set(id, sent);
    records.set(id, {
      boundsLayout: "focused",
      gameHostRendererId: 1,
      scope: Scope.makeUnsafe(),
      gameView: makeView((presentation) => sent.push(presentation)),
      gameViewPhase: "ready",
      lifetime: {
        rendererId: id,
        generation: 0,
        scope: Scope.makeUnsafe(),
        isCurrent: () => true,
      },
      hostWindow: window,
      kind: "game",
      rendererId: id,
      rendererReady: true,
    });
  }
  const host: DesktopGameHostRecord = {
    scope: Scope.makeUnsafe(),
    groupControlsNativeDialogOpen: false,
    groupControlsOpen: false,
    groupControlsView: makeView(),
    groupTargets: new Set(),
    hostView: makeView(),
    layout: "focused",
    tabs: [...records.values()],
    rendererId: 1,
    selected: records.get(ids[0]!)!,
    shortcutModifierPressed: false,
    tabMenuOpen: false,
    window,
  };
  const hosts = makeDesktopGameHosts({
    onStateChanged: () => {},
    platform: "darwin",
  });
  hosts.refresh(host);
  const size = (id: number) => {
    const { height, width } = records.get(id)!.gameView.getBounds();
    return `${width}x${height}`;
  };
  const tiled = (id: number) => presentations.get(id)!.at(-1)?.tiled;
  const show = (
    layout: DesktopGameHostRecord["layout"],
    selectedId = host.selected.rendererId,
  ) => {
    host.layout = layout;
    host.selected = records.get(selectedId)!;
    hosts.refresh(host);
  };
  const resizeWindow = (width: number, height: number) => {
    content = { ...content, height, width };
    hosts.finishResize(host);
  };
  const activate = (id: number) => hosts.activate(host, records.get(id)!);
  return { activate, host, hosts, resizeWindow, show, size, tiled };
};

describe("game view layout", () => {
  it("resizes only the selected view when returning to the focused layout", () => {
    const { show, size, tiled } = makeHost([2, 3, 4, 5]);
    expect([size(2), size(3)]).toEqual(["1200x800", "1200x800"]);

    show("grid");
    expect([size(2), size(3), size(4), size(5)]).toEqual([
      "600x400",
      "600x400",
      "600x400",
      "600x400",
    ]);

    show("focused");
    expect([size(2), size(3), size(4), size(5)]).toEqual([
      "1200x800",
      "600x400",
      "600x400",
      "600x400",
    ]);
    expect([tiled(2), tiled(3)]).toEqual([false, true]);
  });

  it("keeps a view full size after another tab is selected", () => {
    const { show, size, tiled } = makeHost([2, 3, 4]);
    show("grid");
    show("focused", 3);
    show("focused", 2);

    expect([size(2), size(3), size(4)]).toEqual([
      "1200x800",
      "1200x800",
      "600x400",
    ]);
    expect([tiled(2), tiled(3), tiled(4)]).toEqual([false, false, true]);
  });

  it("leaves hidden tiles alone when the focused window resizes", () => {
    const { resizeWindow, show, size } = makeHost([2, 3, 4]);
    show("grid");
    show("focused", 3);
    show("focused", 2);
    resizeWindow(1000, 630);

    expect([size(2), size(3), size(4)]).toEqual([
      "1000x600",
      "1000x600",
      "600x400",
    ]);
  });

  it("shows a tile's top nav once a window resize brings it to full size", () => {
    const { activate, resizeWindow, show, size, tiled } = makeHost([2, 3]);
    show("grid");
    show("focused", 2);
    activate(3);
    resizeWindow(1000, 630);

    expect([size(3), tiled(3)]).toEqual(["1000x600", false]);
  });
});

describe("game view tab ids", () => {
  it("encodes renderer ids and rejects malformed tokens without selecting another tab", () => {
    const { host, hosts } = makeHost([2, 3]);
    host.groupTargets.add(host.tabs[1]!);
    expect(hosts.state(host)).toEqual({
      capacity: 7,
      groupControlsOpen: false,
      groupTargetIds: ["3"],
      layout: "focused",
      selectedId: "2",
      sessions: [
        { id: "2", name: "Tab 1", phase: "ready" },
        { id: "3", name: "Tab 2", phase: "ready" },
      ],
    });
    hosts.select(host, parseGameViewTabId("3"), "view");
    expect(hosts.state(host).selectedId).toBe("3");
    for (const id of ["", "02", "2junk", "game-old-id"]) {
      expect(() => hosts.select(host, parseGameViewTabId(id), "view")).toThrow(
        "Game view does not belong to this host: NaN",
      );
      expect(hosts.state(host).selectedId).toBe("3");
    }
    expect(() => hosts.select(host, parseGameViewTabId("4"), "view")).toThrow(
      "Game view does not belong to this host: 4",
    );
    expect(hosts.state(host).selectedId).toBe("3");
  });
});
