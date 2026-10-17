import { describe, expect, it } from "@effect/vitest";

import {
  reloadUsableRendererContents,
  type RendererReloadContentTarget,
} from "./DesktopDevRendererReload";

const makeContents = (input: {
  readonly destroyed?: boolean;
  readonly onReload: () => void;
}): RendererReloadContentTarget => ({
  isDestroyed: () => input.destroyed ?? false,
  reloadIgnoringCache: input.onReload,
});

describe("reloadUsableRendererContents", () => {
  it("reloads owned renderers only while usable", () => {
    const reloaded: number[] = [];
    const count = reloadUsableRendererContents([
      makeContents({ onReload: () => reloaded.push(1) }),
      makeContents({ onReload: () => reloaded.push(2) }),
      makeContents({
        destroyed: true,
        onReload: () => reloaded.push(3),
      }),
    ]);

    expect(count).toBe(2);
    expect(reloaded).toEqual([1, 2]);
  });
});
