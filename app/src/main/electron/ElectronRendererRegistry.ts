import type { WebContents } from "electron";

/** App-owned contents, including detached views; excludes DevTools and other guests. */
export const makeElectronRendererRegistry = () => {
  const contents = new Map<number, WebContents>();
  return {
    register: (renderer: WebContents): void => {
      const id = renderer.id;
      contents.set(id, renderer);
      renderer.once("destroyed", () => contents.delete(id));
    },
    fromId: (id: number): WebContents | undefined => contents.get(id),
    getAllWebContents: (): readonly WebContents[] => [...contents.values()],
  };
};

export const electronRendererRegistry = makeElectronRendererRegistry();
