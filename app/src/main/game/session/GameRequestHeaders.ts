export const getGameUserAgent = (platform: NodeJS.Platform): string => {
  if (platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36";
  }

  if (platform === "linux") {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36";
  }

  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36";
};

export const getGameRequestHeaders = (
  platform: NodeJS.Platform,
): Record<string, string> => ({
  "User-Agent": getGameUserAgent(platform),
  "X-Requested-With": "ShockwaveFlash/32.0.0.371",
  artixmode: "launcher",
});

export const ARTIX_DOMAINS = ["aq.com", "aqworlds.com", "artix.com"] as const;

export const isArtixHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return ARTIX_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
};

const isHeaderMissingFromLauncher = (name: string): boolean =>
  name.startsWith("sec-ch-ua") || name === "priority";

const isHeaderRewrittenForLauncher = (name: string): boolean =>
  name === "accept-encoding" || name === "origin";

const launcherSendsOrigin = (method: string): boolean =>
  method !== "GET" && method !== "HEAD";

export const applyLauncherHeaders = (
  headers: Record<string, string>,
  method: string,
  url: string,
): void => {
  const target = new URL(url);
  if (!isArtixHost(target.hostname)) return;

  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (
      isHeaderMissingFromLauncher(normalized) ||
      isHeaderRewrittenForLauncher(normalized)
    ) {
      delete headers[name];
    }
  }
  headers["Accept-Encoding"] = "gzip, deflate, br";
  if (launcherSendsOrigin(method)) {
    headers["Origin"] = target.origin;
  }
};
