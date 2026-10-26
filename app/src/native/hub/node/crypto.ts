import { host } from "../../runtime/host";
import { Buffer } from "./buffer";

export const randomBytes = (size: number): Buffer => {
  const bytes = Buffer.alloc(size);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const randomUUID = (): string => crypto.randomUUID();

type Digest = "hex" | "base64" | "latin1" | undefined;

class Hash {
  readonly #algorithm: string;
  readonly #chunks: Uint8Array[] = [];

  constructor(algorithm: string) {
    if (algorithm !== "sha256" && algorithm !== "sha1") {
      throw new Error(`Digest method not supported: ${algorithm}`);
    }
    this.#algorithm = algorithm;
  }

  update(
    data: string | Uint8Array,
    encoding?: "utf8" | "hex" | "base64",
  ): this {
    this.#chunks.push(
      typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data,
    );
    return this;
  }

  digest(): Buffer;
  digest(encoding: Exclude<Digest, undefined>): string;
  digest(encoding?: Digest): Buffer | string {
    const hex = String(
      host().call(
        "hash",
        this.#algorithm,
        Buffer.concat(this.#chunks).toString("base64"),
      ),
    );
    const bytes = Buffer.from(hex, "hex");
    return encoding === undefined ? bytes : bytes.toString(encoding);
  }
}

export const createHash = (algorithm: string): Hash => new Hash(algorithm);

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length)
    throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
};

export default { randomBytes, randomUUID, createHash, timingSafeEqual };
