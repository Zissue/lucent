import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import { HostFsError, hostFs, type HostStat } from "../hostFs";
import { dirname, join } from "./path";

const tagFor = (code: string): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return "NotFound";
    case "EEXIST":
      return "AlreadyExists";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "PermissionDenied";
    case "EBUSY":
      return "Busy";
    default:
      return "Unknown";
  }
};

const attempt = <A>(method: string, path: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: cause instanceof HostFsError ? tagFor(cause.code) : "Unknown",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        cause,
      }),
  });

const unsupported = (method: string) =>
  Effect.fail(
    PlatformError.badArgument({
      module: "FileSystem",
      method,
      description: `${method} is not available in the native app`,
    }),
  );

const info = (stat: HostStat): FileSystem.File.Info => ({
  type:
    stat.kind === "file"
      ? "File"
      : stat.kind === "directory"
        ? "Directory"
        : stat.kind === "symlink"
          ? "SymbolicLink"
          : "Unknown",
  mtime: Option.some(new Date(stat.mtimeMs)),
  atime: Option.some(new Date(stat.atimeMs)),
  birthtime: Option.some(new Date(stat.birthtimeMs)),
  dev: stat.dev,
  ino: Option.some(stat.ino),
  mode: stat.mode,
  nlink: Option.some(stat.nlink),
  uid: Option.some(stat.uid),
  gid: Option.some(stat.gid),
  rdev: Option.none(),
  size: ByteSize.bytes(BigInt(stat.size)),
  blksize: Option.none(),
  blocks: Option.none(),
});

const tempName = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

const tempRoot = (): string =>
  String(
    (globalThis as { __paths?: { temp: string } }).__paths?.temp ?? "/tmp",
  );

const readDirectory = (path: string, recursive: boolean): string[] => {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of hostFs.readdir(
      relative === "" ? path : join(path, relative),
    )) {
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      out.push(name);
      if (recursive && entry.kind === "directory") walk(name);
    }
  };
  walk("");
  return out;
};

const makeTempDirectory = (options?: {
  readonly directory?: string | undefined;
  readonly prefix?: string | undefined;
}) =>
  attempt("makeTempDirectory", options?.directory ?? tempRoot(), () =>
    hostFs.mkdtemp(
      join(options?.directory ?? tempRoot(), options?.prefix ?? ""),
    ),
  );

const makeTempFile = (options?: {
  readonly directory?: string | undefined;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
}) =>
  Effect.flatMap(makeTempDirectory(options), (directory) => {
    const path = join(
      directory,
      `${tempName(options?.prefix ?? "")}${options?.suffix ?? ""}`,
    );
    return attempt("makeTempFile", path, () => {
      hostFs.writeFile(path, new Uint8Array(), "wx");
      return path;
    });
  });

const remove = (
  path: string,
  options?: {
    readonly recursive?: boolean | undefined;
    readonly force?: boolean | undefined;
  },
) =>
  attempt("remove", path, () =>
    hostFs.rm(path, options?.recursive === true, options?.force === true),
  );

const base = FileSystem.make({
  access: (path) => attempt("access", path, () => void hostFs.stat(path, true)),
  copy: (from, to) => attempt("copy", from, () => hostFs.copyFile(from, to)),
  copyFile: (from, to) =>
    attempt("copyFile", from, () => hostFs.copyFile(from, to)),
  chmod: (path, mode) => attempt("chmod", path, () => hostFs.chmod(path, mode)),
  chown: () => unsupported("chown"),
  glob: () => unsupported("glob"),
  link: () => unsupported("link"),
  makeDirectory: (path, options) =>
    attempt(
      "makeDirectory",
      path,
      () => void hostFs.mkdir(path, options?.recursive === true, options?.mode),
    ),
  makeTempDirectory,
  makeTempDirectoryScoped: (options) =>
    Effect.acquireRelease(makeTempDirectory(options), (path) =>
      Effect.ignore(remove(path, { recursive: true, force: true })),
    ),
  makeTempFile,
  makeTempFileScoped: (options) =>
    Effect.acquireRelease(makeTempFile(options), (path) =>
      Effect.ignore(remove(dirname(path), { recursive: true, force: true })),
    ),
  open: () => unsupported("open"),
  readDirectory: (path, options) =>
    attempt("readDirectory", path, () =>
      readDirectory(path, options?.recursive === true),
    ),
  readFile: (path) => attempt("readFile", path, () => hostFs.readFile(path)),
  readLink: (path) => attempt("readLink", path, () => hostFs.readlink(path)),
  realPath: (path) => attempt("realPath", path, () => hostFs.realpath(path)),
  remove,
  rename: (from, to) => attempt("rename", from, () => hostFs.rename(from, to)),
  stat: (path) => attempt("stat", path, () => info(hostFs.stat(path, true))),
  symlink: (target, path) =>
    attempt("symlink", path, () => hostFs.symlink(target, path)),
  truncate: (path, length) =>
    attempt("truncate", path, () => hostFs.truncate(path, length ?? 0)),
  utimes: (path, atime, mtime) =>
    attempt("utimes", path, () =>
      hostFs.utimes(
        path,
        atime instanceof Date ? atime.getTime() : atime,
        mtime instanceof Date ? mtime.getTime() : mtime,
      ),
    ),
  watch: () =>
    Stream.fail(
      PlatformError.badArgument({
        module: "FileSystem",
        method: "watch",
        description: "watch is not available in the native app",
      }),
    ),
  writeFile: (path, data, options) =>
    attempt("writeFile", path, () =>
      hostFs.writeFile(path, data, options?.flag ?? "w", options?.mode),
    ),
});

/** `open` is unavailable, so `stream` reads the requested range in one host call. */
const stream: FileSystem.FileSystem["stream"] = (path, options) =>
  Stream.fromEffect(
    attempt("stream", path, () => {
      const limit =
        options?.bytesToRead === undefined
          ? undefined
          : Number(ByteSize.fromInputUnsafe(options.bytesToRead));
      const offset =
        options?.offset === undefined
          ? 0
          : Number(ByteSize.fromInputUnsafe(options.offset));
      const bytes = hostFs.readFile(
        path,
        limit === undefined ? undefined : offset + limit,
      );
      const start = Math.min(offset, bytes.length);
      return bytes.subarray(
        start,
        limit === undefined ? undefined : start + limit,
      );
    }),
  );

export const fileSystem: FileSystem.FileSystem = { ...base, stream };

export const layer = Layer.succeed(FileSystem.FileSystem, fileSystem);
