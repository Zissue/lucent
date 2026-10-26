const paths = (): { readonly home: string; readonly temp: string } =>
  (globalThis as unknown as { __paths: { home: string; temp: string } })
    .__paths;

export const homedir = (): string => paths().home;
export const tmpdir = (): string => paths().temp;
export const platform = (): string =>
  (globalThis as unknown as { process: { platform: string } }).process.platform;
export const EOL = "\n";

export default { homedir, tmpdir, platform, EOL };
