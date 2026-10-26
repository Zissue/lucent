type Encoding =
  | "utf8"
  | "utf-8"
  | "hex"
  | "base64"
  | "latin1"
  | "binary"
  | "ascii";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

class BufferBytes extends Uint8Array {
  override toString(
    encoding: Encoding = "utf8",
    start = 0,
    end = this.length,
  ): string {
    const view = this.subarray(start, end);
    switch (encoding) {
      case "hex":
        return [...view]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      case "base64":
        return toBase64(view);
      case "latin1":
      case "binary":
      case "ascii":
        return String.fromCharCode(...view);
      default:
        return decoder.decode(view);
    }
  }

  equals(other: Uint8Array): boolean {
    return (
      this.length === other.length &&
      this.every((byte, index) => byte === other[index])
    );
  }

  toJSON(): { type: "Buffer"; data: number[] } {
    return { type: "Buffer", data: [...this] };
  }
}

const statics = {
  from(
    value: string | ArrayBufferLike | ArrayLike<number> | Iterable<number>,
    encodingOrOffset?: Encoding | number,
    length?: number,
  ): BufferBytes {
    if (typeof value === "string") {
      const encoding = (encodingOrOffset as Encoding | undefined) ?? "utf8";
      const bytes =
        encoding === "hex"
          ? Uint8Array.from(value.match(/../g) ?? [], (pair) =>
              parseInt(pair, 16),
            )
          : encoding === "base64"
            ? fromBase64(value)
            : encoding === "latin1" ||
                encoding === "binary" ||
                encoding === "ascii"
              ? Uint8Array.from(value, (ch) => ch.charCodeAt(0) & 255)
              : encoder.encode(value);
      return new BufferBytes(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
    }
    if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer)
    ) {
      return new BufferBytes(
        value as ArrayBuffer,
        encodingOrOffset as number | undefined,
        length,
      );
    }
    const bytes = Uint8Array.from(value as ArrayLike<number>);
    return new BufferBytes(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  },

  alloc(size: number, fill = 0): BufferBytes {
    const buffer = new BufferBytes(size);
    if (fill !== 0) buffer.fill(fill);
    return buffer;
  },

  allocUnsafe(size: number): BufferBytes {
    return new BufferBytes(size);
  },

  isBuffer(value: unknown): value is BufferBytes {
    return value instanceof BufferBytes;
  },

  byteLength(
    value: string | ArrayBufferView | ArrayBuffer,
    encoding: Encoding = "utf8",
  ): number {
    if (typeof value === "string")
      return statics.from(value, encoding).byteLength;
    return value.byteLength;
  },

  compare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) {
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  },

  concat(list: readonly Uint8Array[], total?: number): BufferBytes {
    const size = total ?? list.reduce((sum, item) => sum + item.byteLength, 0);
    const out = statics.alloc(size);
    let offset = 0;
    for (const item of list) {
      out.set(item.subarray(0, Math.max(0, size - offset)), offset);
      offset += item.byteLength;
      if (offset >= size) break;
    }
    return out;
  },
};

export const Buffer = Object.assign(BufferBytes, statics);
export type Buffer = BufferBytes;

export default { Buffer };
