import {
  hostFs,
  type FileKind,
  type HostDirent,
  type HostStat,
} from "../hostFs";
import { Buffer } from "./buffer";

export class Stats {
  readonly #kind: FileKind;
  readonly size: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;

  constructor(stat: HostStat) {
    this.#kind = stat.kind;
    this.size = stat.size;
    this.mode = stat.mode;
    this.dev = stat.dev;
    this.ino = stat.ino;
    this.nlink = stat.nlink;
    this.uid = stat.uid;
    this.gid = stat.gid;
    this.atimeMs = stat.atimeMs;
    this.mtimeMs = stat.mtimeMs;
    this.ctimeMs = stat.ctimeMs;
    this.birthtimeMs = stat.birthtimeMs;
    this.atime = new Date(stat.atimeMs);
    this.mtime = new Date(stat.mtimeMs);
    this.ctime = new Date(stat.ctimeMs);
    this.birthtime = new Date(stat.birthtimeMs);
  }

  isFile(): boolean {
    return this.#kind === "file";
  }
  isDirectory(): boolean {
    return this.#kind === "directory";
  }
  isSymbolicLink(): boolean {
    return this.#kind === "symlink";
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  readonly path: string;
  readonly #kind: FileKind;

  constructor(entry: HostDirent, parentPath: string) {
    this.name = entry.name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this.#kind = entry.kind;
  }

  isFile(): boolean {
    return this.#kind === "file";
  }
  isDirectory(): boolean {
    return this.#kind === "directory";
  }
  isSymbolicLink(): boolean {
    return this.#kind === "symlink";
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

type Encoding = BufferEncoding | null | undefined;
type BufferEncoding = "utf8" | "utf-8" | "hex" | "base64" | "latin1";
type ReadOptions =
  | Encoding
  | { readonly encoding?: Encoding; readonly flag?: string };
type WriteOptions =
  | Encoding
  | {
      readonly encoding?: Encoding;
      readonly flag?: string;
      readonly mode?: number;
    };

const encodingOf = (options: ReadOptions | WriteOptions): Encoding =>
  typeof options === "string" ? options : (options?.encoding ?? null);

const toBytes = (data: string | Uint8Array, encoding: Encoding): Uint8Array =>
  typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;

export const statSync = (path: string): Stats =>
  new Stats(hostFs.stat(path, true));
export const lstatSync = (path: string): Stats =>
  new Stats(hostFs.stat(path, false));

export const existsSync = (path: string): boolean => {
  try {
    hostFs.stat(path, true);
    return true;
  } catch {
    return false;
  }
};

export function readFileSync(
  path: string,
  options?: ReadOptions,
): string | Buffer {
  const bytes = hostFs.readFile(path);
  const buffer = Buffer.from(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const encoding = encodingOf(options ?? null);
  return encoding === null || encoding === undefined
    ? buffer
    : buffer.toString(encoding);
}

export const writeFileSync = (
  path: string,
  data: string | Uint8Array,
  options?: WriteOptions,
): void => {
  const flag =
    typeof options === "object" && options !== null
      ? (options.flag ?? "w")
      : "w";
  const mode =
    typeof options === "object" && options !== null && "mode" in options
      ? options.mode
      : undefined;
  hostFs.writeFile(
    path,
    toBytes(data, encodingOf(options ?? null)),
    flag,
    mode,
  );
};

export const mkdirSync = (
  path: string,
  options?: { readonly recursive?: boolean; readonly mode?: number } | number,
): string | undefined =>
  hostFs.mkdir(
    path,
    typeof options === "object" && options.recursive === true,
    typeof options === "number" ? options : options?.mode,
  );

export function readdirSync(
  path: string,
  options?: { readonly withFileTypes?: boolean },
): string[] | Dirent[] {
  const entries = hostFs.readdir(path);
  return options?.withFileTypes === true
    ? entries.map((entry) => new Dirent(entry, path))
    : entries.map((entry) => entry.name);
}

export const rmSync = (
  path: string,
  options?: { readonly recursive?: boolean; readonly force?: boolean },
): void =>
  hostFs.rm(path, options?.recursive === true, options?.force === true);

export const unlinkSync = (path: string): void => hostFs.rm(path, false, false);
export const rmdirSync = (path: string): void => hostFs.rm(path, false, false);
export const renameSync = (from: string, to: string): void =>
  hostFs.rename(from, to);
export const realpathSync = (path: string): string => hostFs.realpath(path);
export const mkdtempSync = (prefix: string): string => hostFs.mkdtemp(prefix);
export const copyFileSync = (from: string, to: string): void =>
  hostFs.copyFile(from, to);
export const chmodSync = (path: string, mode: number): void =>
  hostFs.chmod(path, mode);
export const readlinkSync = (path: string): string => hostFs.readlink(path);
export const symlinkSync = (target: string, path: string): void =>
  hostFs.symlink(target, path);

const later = <A>(run: () => A): Promise<A> => {
  try {
    return Promise.resolve(run());
  } catch (cause) {
    return Promise.reject(cause);
  }
};

class Dir {
  readonly #entries: Dirent[];
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.#entries = readdirSync(path, { withFileTypes: true }) as Dirent[];
  }
  async read(): Promise<Dirent | null> {
    return this.#entries.shift() ?? null;
  }
  readSync(): Dirent | null {
    return this.#entries.shift() ?? null;
  }
  async close(): Promise<void> {}
  closeSync(): void {}
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
    for (;;) {
      const entry = this.#entries.shift();
      if (entry === undefined) return;
      yield entry;
    }
  }
}

export const promises = {
  stat: (path: string) => later(() => statSync(path)),
  lstat: (path: string) => later(() => lstatSync(path)),
  readFile: (path: string, options?: ReadOptions) =>
    later(() => readFileSync(path, options)),
  writeFile: (
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions,
  ) => later(() => writeFileSync(path, data, options)),
  mkdir: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => later(() => mkdirSync(path, options)),
  readdir: (path: string, options?: { readonly withFileTypes?: boolean }) =>
    later(() => readdirSync(path, options)),
  opendir: (path: string) => later(() => new Dir(path)),
  rm: (
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ) => later(() => rmSync(path, options)),
  rmdir: (path: string) => later(() => rmdirSync(path)),
  unlink: (path: string) => later(() => unlinkSync(path)),
  rename: (from: string, to: string) => later(() => renameSync(from, to)),
  realpath: (path: string) => later(() => realpathSync(path)),
  mkdtemp: (prefix: string) => later(() => mkdtempSync(prefix)),
  copyFile: (from: string, to: string) => later(() => copyFileSync(from, to)),
  chmod: (path: string, mode: number) => later(() => chmodSync(path, mode)),
  access: (path: string) => later(() => void statSync(path)),
};

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0x200,
  O_EXCL: 0x800,
  O_NOFOLLOW: 0x100,
};

export default {
  Stats,
  Dirent,
  constants,
  promises,
  statSync,
  lstatSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  realpathSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  readlinkSync,
  symlinkSync,
};
