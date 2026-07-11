declare module "lz4js" {
  export function makeBuffer(size: number): Uint8Array;
  export function compressBound(size: number): number;
  export function compressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    hashTable: Uint32Array
  ): number;
  export function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number
  ): number;
}
