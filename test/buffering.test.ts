import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countToKeepInFlight, bufferedSeconds, estimateAudioMs } from '../src/player/buffering';
import { RtfTracker } from '../src/tts/stats';

test('countToKeepInFlight covers the target with known and estimated lengths', () => {
  const items = [
    { audioMs: 4000, textLength: 60 },
    { textLength: 150 },           // ~6.8 s estimated
    { audioMs: 8000, textLength: 120 },
    { textLength: 300 },
  ];
  assert.equal(countToKeepInFlight(items, 18, 8), 3, '4 + 6.8 + 8 = 18.8 s >= 18 s after three items');
  assert.equal(countToKeepInFlight(items, 20, 8), 4, '18.8 s < 20 s, so the fourth item is needed');
  assert.equal(countToKeepInFlight(items, 100, 8), 4, 'capped by the number of items');
  assert.equal(countToKeepInFlight(items, 100, 2), 2, 'capped by maxCount');
  assert.equal(countToKeepInFlight(items, 1, 8), 2, 'never fewer than two when available');
  assert.equal(countToKeepInFlight([{ textLength: 10 }], 20, 8), 1, 'a single remaining item');
  assert.ok(estimateAudioMs(150) > 6000 && estimateAudioMs(150) < 8000);
});

test('bufferedSeconds counts only synthesized audio', () => {
  assert.equal(bufferedSeconds([{ audioMs: 1500, textLength: 1 }, { textLength: 400 }, { audioMs: 500, textLength: 1 }]), 2);
});

test('RtfTracker averages and ignores tiny clips', () => {
  const t = new RtfTracker(0.5);
  t.add(100, 100);   // ignored: audio shorter than 300 ms
  assert.equal(t.samples, 0);
  t.add(2000, 4000); // rtf 0.5
  t.add(4000, 4000); // rtf 1.0 -> ema 0.75
  assert.equal(t.samples, 2);
  assert.ok(Math.abs(t.rtf - 0.75) < 1e-9);
  t.reset();
  assert.equal(t.samples, 0);
});
