const KiB = 1_024;
const MiB = 1_024 * KiB;

export const SCRIPT_FILE_MAX_BYTES = 16 * MiB;
export const SCRIPT_SNAPSHOT_MAX_BYTES = 64 * MiB;

export const SCRIPT_PACKAGE_MANIFEST_MAX_BYTES = MiB;
export const SCRIPT_PACKAGE_FILE_MAX_BYTES = 64 * MiB;
export const SCRIPT_PACKAGE_MAX_BYTES = 256 * MiB;
export const SCRIPT_PACKAGE_MAX_FILES = 10_000;
export const SCRIPT_PACKAGE_DIRECTORY_SLUG_MAX_BYTES = 120;

export const SCRIPT_PACKAGE_ARCHIVE_MAX_BYTES = 64 * MiB;

// Archive inventories count directories as well as files.
export const SCRIPT_PACKAGE_ARCHIVE_MAX_ENTRIES = 10_000;
export const SCRIPT_PACKAGE_ARCHIVE_PATH_MAX_BYTES = KiB;
export const SCRIPT_PACKAGE_PATH_COMPONENT_MAX_BYTES = 255;
export const SCRIPT_PACKAGE_METADATA_MAX_BYTES = 16 * MiB;

export const SCRIPT_SOURCE_CACHE_MAX_BYTES = 128 * MiB;
export const SCRIPT_SOURCE_CACHE_MAX_ENTRIES = 1_024;
export const SCRIPT_ANALYSIS_CACHE_MAX_BYTES = 32 * MiB;
export const SCRIPT_ANALYSIS_CACHE_MAX_ENTRIES = 64;

export const formatBytes = (bytes: number): string => {
  if (bytes % MiB === 0) return `${bytes / MiB} MiB`;
  if (bytes % KiB === 0) return `${bytes / KiB} KiB`;
  return `${bytes} bytes`;
};
