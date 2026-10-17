import { net, protocol, type Session } from "electron";
import { join, normalize, sep } from "path";
import { pathToFileURL } from "url";

export const RUFFLE_ASSET_SCHEME = "lucent-asset";

export const registerRuffleAssetScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RUFFLE_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
};

export const handleRuffleAssets = (
  targetSession: Session,
  assetsDir: string,
): void => {
  const root = normalize(assetsDir) + sep;
  targetSession.protocol.handle(RUFFLE_ASSET_SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (host !== "assets" || !file.startsWith(root)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
};

const ARTIX_URL_PATTERNS = [
  "https://*.aq.com/*",
  "https://*.aqworlds.com/*",
  "https://*.artix.com/*",
];

export const allowArtixCors = (targetSession: Session): void => {
  targetSession.webRequest.onHeadersReceived(
    { urls: ARTIX_URL_PATTERNS },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase().startsWith("access-control-allow-")) {
          delete responseHeaders[name];
        }
      }
      responseHeaders["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders });
    },
  );
};
