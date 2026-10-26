import { host } from "../runtime/host";
import { fromBase64, toBase64 } from "./node/buffer";

export type FileKind = "file" | "directory" | "symlink" | "other";

export interface HostStat {
  readonly kind: FileKind;
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
}

export interface HostDirent {
  readonly name: string;
  readonly kind: FileKind;
}

/** A Node-style error with `code`, as `node:fs` throws it. */
export class HostFsError extends Error {
  readonly code: string;
  readonly syscall: string;
  readonly path: string;
  constructor(code: string, syscall: string, path: string, message: string) {
    super(`${code}: ${message}, ${syscall} '${path}'`);
    this.name = "Error";
    this.code = code;
    this.syscall = syscall;
    this.path = path;
  }
}

const call = (
  op: string,
  path: string,
  ...args: (string | number | boolean | undefined)[]
) => {
  try {
    return host().call("fs", op, path, ...args);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const at = message.indexOf(":");
    const code = at > 0 ? message.slice(0, at) : "EIO";
    throw new HostFsError(
      code,
      op,
      path,
      at > 0 ? message.slice(at + 1).trim() : message,
    );
  }
};

export const hostFs = {
  stat: (path: string, follow = true): HostStat =>
    JSON.parse(String(call("stat", path, follow))),
  readFile: (path: string, maxBytes?: number): Uint8Array =>
    fromBase64(String(call("readFile", path, maxBytes))),
  writeFile: (
    path: string,
    data: Uint8Array,
    flag = "w",
    mode?: number,
  ): void => {
    call("writeFile", path, toBase64(data), flag, mode);
  },
  rename: (from: string, to: string): void => {
    call("rename", from, to);
  },
  mkdir: (
    path: string,
    recursive: boolean,
    mode?: number,
  ): string | undefined => {
    const created = call("mkdir", path, recursive, mode);
    return typeof created === "string" ? created : undefined;
  },
  rm: (path: string, recursive: boolean, force: boolean): void => {
    call("rm", path, recursive, force);
  },
  readdir: (path: string): HostDirent[] =>
    JSON.parse(String(call("readdir", path))),
  mkdtemp: (prefix: string): string => String(call("mkdtemp", prefix)),
  realpath: (path: string): string => String(call("realpath", path)),
  readlink: (path: string): string => String(call("readlink", path)),
  symlink: (target: string, path: string): void => {
    call("symlink", path, target);
  },
  copyFile: (from: string, to: string): void => {
    call("copyFile", from, to);
  },
  chmod: (path: string, mode: number): void => {
    call("chmod", path, mode);
  },
  truncate: (path: string, length: number): void => {
    call("truncate", path, length);
  },
  utimes: (path: string, atimeMs: number, mtimeMs: number): void => {
    call("utimes", path, atimeMs, mtimeMs);
  },
};
