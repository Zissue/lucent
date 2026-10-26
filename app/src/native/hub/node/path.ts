export const sep = "/";
export const delimiter = ":";

const normalizeSegments = (path: string, absolute: boolean): string => {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
};

export const isAbsolute = (path: string): boolean => path.startsWith("/");

export const normalize = (path: string): string => {
  if (path === "") return ".";
  const absolute = isAbsolute(path);
  const trailing = path.endsWith("/");
  let body = normalizeSegments(path, absolute);
  if (body === "" && !absolute) body = ".";
  if (body !== "" && trailing) body += "/";
  return absolute ? `/${body}` : body;
};

export const join = (...parts: string[]): string => {
  const joined = parts.filter((part) => part !== "").join("/");
  return joined === "" ? "." : normalize(joined);
};

export const cwd = (): string => "/";

export const resolve = (...parts: string[]): string => {
  let resolved = "";
  for (
    let index = parts.length - 1;
    index >= 0 && !isAbsolute(resolved);
    index--
  ) {
    const part = parts[index]!;
    if (part === "") continue;
    resolved = resolved === "" ? part : `${part}/${resolved}`;
  }
  if (!isAbsolute(resolved)) resolved = `${cwd()}/${resolved}`;
  const body = normalizeSegments(resolved, true);
  return `/${body}`;
};

export const dirname = (path: string): string => {
  if (path === "") return ".";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return ".";
  if (at === 0) return "/";
  return trimmed.slice(0, at);
};

export const basename = (path: string, suffix?: string): string => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (suffix !== undefined && base.endsWith(suffix) && base !== suffix) {
    base = base.slice(0, -suffix.length);
  }
  return base;
};

export const extname = (path: string): string => {
  const base = basename(path);
  const at = base.lastIndexOf(".");
  return at <= 0 ? "" : base.slice(at);
};

export const relative = (from: string, to: string): string => {
  const source = resolve(from).split("/").filter(Boolean);
  const target = resolve(to).split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < source.length &&
    shared < target.length &&
    source[shared] === target[shared]
  ) {
    shared++;
  }
  return [
    ...source.slice(shared).map(() => ".."),
    ...target.slice(shared),
  ].join("/");
};

export const parse = (path: string) => {
  const root = isAbsolute(path) ? "/" : "";
  const base = basename(path);
  const ext = extname(path);
  const dir = path.includes("/") ? dirname(path) : "";
  return {
    root,
    dir,
    base,
    ext,
    name: ext === "" ? base : base.slice(0, -ext.length),
  };
};

export const format = (input: {
  readonly root?: string;
  readonly dir?: string;
  readonly base?: string;
  readonly name?: string;
  readonly ext?: string;
}): string => {
  const base = input.base ?? `${input.name ?? ""}${input.ext ?? ""}`;
  const dir = input.dir ?? input.root ?? "";
  if (dir === "") return base;
  return dir.endsWith("/") ? `${dir}${base}` : `${dir}/${base}`;
};

export const toNamespacedPath = (path: string): string => path;

const path = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
  format,
  toNamespacedPath,
};

export const posix = path;
export const win32 = path;

export default { ...path, posix, win32 };
