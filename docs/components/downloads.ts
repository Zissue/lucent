export type DownloadPlatform = "mac" | "windows" | "linux";
export type DownloadArch = "universal" | "x64" | "arm64";

export interface Download {
  readonly platform: DownloadPlatform;
  readonly arch: DownloadArch;
  readonly format: "DMG" | "ZIP" | "AppImage";
  readonly suffix: string;
}

export interface ReleaseAsset {
  readonly url: string;
  readonly size: number;
}

export interface LatestRelease {
  readonly tag: string;
  readonly publishedAt: Date | null;
  readonly assets: ReadonlyMap<string, ReleaseAsset>;
}

export const releasesUrl = "https://github.com/toommyliu/lucent/releases";
export const latestAssetsUrl = `${releasesUrl}/latest#assets`;

export const downloads: readonly Download[] = [
  {
    platform: "mac",
    arch: "universal",
    format: "DMG",
    suffix: "-mac-universal.dmg",
  },
  { platform: "windows", arch: "x64", format: "ZIP", suffix: "-win-x64.zip" },
  {
    platform: "windows",
    arch: "arm64",
    format: "ZIP",
    suffix: "-win-arm64.zip",
  },
  {
    platform: "linux",
    arch: "x64",
    format: "AppImage",
    suffix: "-linux-x86_64.AppImage",
  },
  {
    platform: "linux",
    arch: "arm64",
    format: "AppImage",
    suffix: "-linux-arm64.AppImage",
  },
  { platform: "linux", arch: "x64", format: "ZIP", suffix: "-linux-x64.zip" },
  {
    platform: "linux",
    arch: "arm64",
    format: "ZIP",
    suffix: "-linux-arm64.zip",
  },
];

const downloadUrlPrefix = `${releasesUrl}/download/`;

export const fetchLatestRelease = async (): Promise<LatestRelease | null> => {
  try {
    const response = await fetch(
      "https://api.github.com/repos/toommyliu/lucent/releases/latest",
    );
    if (!response.ok) return null;

    const release: unknown = await response.json();
    if (
      typeof release !== "object" ||
      release === null ||
      !("tag_name" in release) ||
      typeof release.tag_name !== "string" ||
      !("assets" in release) ||
      !Array.isArray(release.assets)
    )
      return null;

    const publishedAt =
      "published_at" in release && typeof release.published_at === "string"
        ? new Date(release.published_at)
        : null;

    const assets = new Map<string, ReleaseAsset>();
    for (const { suffix } of downloads) {
      const asset: unknown = release.assets.find(
        (candidate: unknown) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "name" in candidate &&
          typeof candidate.name === "string" &&
          candidate.name.startsWith("Lucent-") &&
          candidate.name.endsWith(suffix),
      );
      if (
        typeof asset === "object" &&
        asset !== null &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.startsWith(downloadUrlPrefix) &&
        "size" in asset &&
        typeof asset.size === "number"
      ) {
        assets.set(suffix, {
          url: asset.browser_download_url,
          size: asset.size,
        });
      }
    }

    return {
      tag: release.tag_name,
      publishedAt:
        publishedAt !== null && !Number.isNaN(publishedAt.getTime())
          ? publishedAt
          : null,
      assets,
    };
  } catch {
    return null;
  }
};
