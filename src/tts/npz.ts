import * as zlib from 'zlib';

export interface NpyArray { shape: number[]; data: Float32Array }

function parseNpy(b: Buffer): NpyArray {
  if (b.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error('Not an .npy entry');
  const major = b[6];
  const headerLen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = b.toString('latin1', headerStart, headerStart + headerLen);
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  const descrMatch = /'descr':\s*'([^']*)'/.exec(header);
  if (!shapeMatch || !descrMatch) throw new Error('Malformed .npy header');
  const shape = shapeMatch[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (descrMatch[1] !== '<f4') throw new Error(`Unsupported voice dtype ${descrMatch[1]}`);
  const n = shape.reduce((a, c) => a * c, 1);
  const dataOffset = headerStart + headerLen;
  const copy = Buffer.from(b.subarray(dataOffset, dataOffset + n * 4));
  return { shape, data: new Float32Array(copy.buffer, copy.byteOffset, n) };
}

/** Read a NumPy .npz archive (zip of .npy files) of float32 arrays. */
export function readNpz(buf: Buffer): Map<string, NpyArray> {
  const out = new Map<string, NpyArray>();
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    let compSize = buf.readUInt32LE(off + 18);
    let uncompSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    let extraOff = off + 30 + nameLen;
    const extraEnd = extraOff + extraLen;
    while (extraOff + 4 <= extraEnd) {
      const id = buf.readUInt16LE(extraOff);
      const sz = buf.readUInt16LE(extraOff + 2);
      if (id === 1) {
        let p = extraOff + 4;
        if (uncompSize === 0xffffffff) { uncompSize = Number(buf.readBigUInt64LE(p)); p += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(p)); p += 8; }
      }
      extraOff += 4 + sz;
    }
    if (flags & 8) throw new Error('Unsupported zip layout (data descriptor)');
    const dataStart = off + 30 + nameLen + extraLen;
    let data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error(`Unsupported zip compression method ${method}`);
    out.set(name.replace(/\.npy$/, ''), parseNpy(data));
    off = dataStart + compSize;
  }
  return out;
}
