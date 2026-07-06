import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { decompressBlock } from "lz4js";

const MAGIC = Buffer.from([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]);
const HEADER_LENGTH = 12;

export function decodeJsonLz4Buffer(buffer: Buffer): unknown {
  if (buffer.length < HEADER_LENGTH) {
    throw new Error("JSONLZ4 file is too short");
  }

  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("JSONLZ4 file has an invalid mozLz40 header");
  }

  const expectedLength = buffer.readUInt32LE(8);
  const destination = new Uint8Array(expectedLength);
  const compressed = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const written = decompressBlock(
    compressed,
    destination,
    HEADER_LENGTH,
    buffer.length - HEADER_LENGTH,
    0
  );

  if (written !== expectedLength) {
    throw new Error(
      `JSONLZ4 decompressed length mismatch: expected ${expectedLength}, got ${written}`
    );
  }

  const json = Buffer.from(destination).toString("utf8");
  return JSON.parse(json);
}

export async function readJsonLz4(path: string): Promise<unknown> {
  return decodeJsonLz4Buffer(await readFile(path));
}

export function encodeLiteralJsonLz4ForFixture(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const literalHeader = encodeLiteralOnlyBlock(payload);
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, literalHeader, payload]);
}

function encodeLiteralOnlyBlock(payload: Buffer): Buffer {
  const length = payload.length;
  const bytes: number[] = [];
  bytes.push(Math.min(15, length) << 4);

  if (length >= 15) {
    let remaining = length - 15;
    while (remaining >= 255) {
      bytes.push(255);
      remaining -= 255;
    }
    bytes.push(remaining);
  }

  return Buffer.from(bytes);
}
