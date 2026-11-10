import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcm16ToWav, float32ToPcm16, aiffToWav } from '../src/util/wav';

test('pcm16ToWav writes a valid header and keeps the samples untouched', () => {
  const pcm = float32ToPcm16(new Float32Array([0, 0.5, -0.5, 1]));
  const wav = pcm16ToWav(pcm, 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.readInt16LE(44 + 2), 16384);
  assert.equal(wav.readInt16LE(44 + 6), 32767);
  assert.ok(wav.subarray(44).equals(pcm));
});

test('aiffToWav converts big-endian samples', () => {
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(1, 0);
  comm.writeUInt32BE(2, 2);
  comm.writeUInt16BE(16, 6);
  comm.writeUInt16BE(16383 + 14, 8);
  comm.writeUInt32BE(22050 * 2 ** 17, 10);
  comm.writeUInt32BE(0, 14);
  const ssnd = Buffer.alloc(8 + 4);
  ssnd.writeInt16BE(1000, 8);
  ssnd.writeInt16BE(-1000, 10);
  const commChunk = Buffer.concat([Buffer.from('COMM'), u32(comm.length), comm]);
  const ssndChunk = Buffer.concat([Buffer.from('SSND'), u32(ssnd.length), ssnd]);
  const body = Buffer.concat([Buffer.from('AIFF'), commChunk, ssndChunk]);
  const aiff = Buffer.concat([Buffer.from('FORM'), u32(body.length), body]);
  const wav = aiffToWav(aiff);
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readInt16LE(44), 1000);
  assert.equal(wav.readInt16LE(46), -1000);
});

function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
