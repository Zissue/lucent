const unavailable = (name: string) => (): never => {
  throw new Error(`${name} is not available in the native app`);
};

export const createServer = unavailable("node:http createServer");
export const request = unavailable("node:http request");
export const createConnection = unavailable("node:net createConnection");
export const pipeline = unavailable("node:stream pipeline");
export const pathToFileURL = (path: string): URL =>
  new URL(`file://${encodeURI(path)}`);
export const fileURLToPath = (url: string | URL): string =>
  decodeURI(new URL(String(url)).pathname);

export default {
  createServer,
  request,
  createConnection,
  pipeline,
  pathToFileURL,
  fileURLToPath,
};

export const createWebSocketStream = unavailable("ws createWebSocketStream");
export class WebSocketServer {
  constructor() {
    unavailable("ws WebSocketServer")();
  }
}
export const list = unavailable("tar list");
export const extract = unavailable("tar extract");
