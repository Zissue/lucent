const LOADER_URL = "lucent-asset://assets/loader.swf";
// Stored per session partition, so each account remembers its own choice.
const SMOOTH_MOTION_KEY = "lucent:smooth-motion";

interface RufflePlayerElement extends HTMLElement {
  ruffle(): {
    load(options: Record<string, unknown>): Promise<void>;
    frameInterpolation: boolean;
  };
}

const readSmoothMotion = (): boolean => {
  try {
    return localStorage.getItem(SMOOTH_MOTION_KEY) !== "off";
  } catch {
    return true;
  }
};

const saveSmoothMotion = (on: boolean): void => {
  try {
    localStorage.setItem(SMOOTH_MOTION_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; the toggle still works for this session.
  }
};

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
  // Smooth Motion is toggled from Ruffle's right-click menu.
  player.ruffle().frameInterpolation = readSmoothMotion();
  player.addEventListener("frameinterpolationchange", () =>
    saveSmoothMotion(player.ruffle().frameInterpolation),
  );
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
