/** Wrap 16-bit little-endian PCM in a WAV container without touching the samples. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Convert float samples in [-1, 1] to 16-bit little-endian PCM. */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), i * 2);
  }
  return buf;
}

/** Convert a 16-bit big-endian AIFF (as produced by macOS `say -o x.aiff`) to a WAV buffer. */
export function aiffToWav(aiff: Buffer): Buffer {
  if (aiff.toString('ascii', 0, 4) !== 'FORM' || aiff.toString('ascii', 8, 12) !== 'AIFF') throw new Error('Not an AIFF file');
  let off = 12;
  let channels = 1, sampleSize = 16, sampleRate = 22050;
  let pcm: Buffer | undefined;
  while (off + 8 <= aiff.length) {
    const id = aiff.toString('ascii', off, off + 4);
    const size = aiff.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM') {
      channels = aiff.readUInt16BE(body);
      sampleSize = aiff.readUInt16BE(body + 6);
      const exp = aiff.readUInt16BE(body + 8) & 0x7fff;
      const hi = aiff.readUInt32BE(body + 10);
      sampleRate = Math.round(hi * Math.pow(2, exp - 16383 - 31));
    } else if (id === 'SSND') {
      const offset = aiff.readUInt32BE(body);
      pcm = aiff.subarray(body + 8 + offset, body + size);
    }
    off = body + size + (size & 1);
  }
  if (!pcm) throw new Error('AIFF file has no sound data');
  if (sampleSize !== 16) throw new Error(`Unsupported AIFF sample size ${sampleSize}`);
  const le = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) { le[i] = pcm[i + 1]; le[i + 1] = pcm[i]; }
  return pcm16ToWav(le, sampleRate, channels);
}
