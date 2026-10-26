const unavailable = (name: string): never => {
  throw new Error(`Electron ${name} is not available in the native app`);
};

const stub = (name: string): unknown =>
  new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "then"
          ? undefined
          : () => unavailable(`${name}.${String(key)}`),
    },
  );

export const app = stub("app");
export const shell = stub("shell");
export const dialog = stub("dialog");
export const ipcMain = stub("ipcMain");
export const BrowserWindow = stub("BrowserWindow");
export const BaseWindow = stub("BaseWindow");
export const WebContentsView = stub("WebContentsView");
export const webContents = stub("webContents");
export const session = stub("session");
export const net = stub("net");
export const protocol = stub("protocol");
export const nativeTheme = stub("nativeTheme");
export const Menu = stub("Menu");
export const MessageChannelMain = stub("MessageChannelMain");
export const contentTracing = stub("contentTracing");
export const screen = stub("screen");
export const powerMonitor = stub("powerMonitor");

export default {
  app,
  shell,
  dialog,
  ipcMain,
  BrowserWindow,
  session,
  net,
  protocol,
};
