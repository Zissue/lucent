const LOADER_URL = "lucent-asset://assets/loader.swf";

interface RufflePlayerElement extends HTMLElement {
  ruffle(): { load(options: Record<string, unknown>): Promise<void> };
}

declare global {
  interface Window {
    RufflePlayer?: { newest(): { createPlayer(): RufflePlayerElement } };
  }
}

export const mountRufflePlayer = async (): Promise<void> => {
  const placeholder = document.getElementById("swf");
  const ruffle = window.RufflePlayer?.newest();
  if (placeholder === null || ruffle === undefined) {
    throw new Error("Ruffle isn't loaded");
  }
  const relay = new URLSearchParams(location.search).get("socketProxy");
  const player = ruffle.createPlayer();
  player.id = "swf";
  placeholder.replaceWith(player);
  await player.ruffle().load({
    url: LOADER_URL,
    allowScriptAccess: true,
    autoplay: "on",
    unmuteOverlay: "hidden",
    splashScreen: false,
    letterbox: "on",
    preferredRenderer: "webgpu",
    socketProxy:
      relay === null
        ? []
        : [
            {
              host: "*",
              port: 0,
              proxyUrl: `${relay}?host={host}&port={port}`,
            },
          ],
  });
};
