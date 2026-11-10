/** Pure helpers for deciding how far ahead to synthesize. */

export interface BufferItem {
  /** Known audio length once synthesized. */
  audioMs?: number;
  textLength: number;
}

/** Rough speech length of text that has not been synthesized yet. Kokoro at speed 1 reads about 25 characters per second; 22 errs toward buffering more. */
export function estimateAudioMs(textLength: number): number {
  return Math.max(400, (textLength / 22) * 1000);
}

/**
 * How many upcoming items (from the current one) should be in flight so that the audio they
 * represent covers `targetSeconds`. Always at least `minCount`, never more than `maxCount`.
 */
export function countToKeepInFlight(items: BufferItem[], targetSeconds: number, maxCount: number, minCount = 2): number {
  const targetMs = targetSeconds * 1000;
  let acc = 0;
  let n = 0;
  for (const item of items) {
    if (n >= maxCount) break;
    n++;
    acc += item.audioMs ?? estimateAudioMs(item.textLength);
    if (acc >= targetMs && n >= minCount) break;
  }
  return Math.min(maxCount, Math.max(Math.min(minCount, items.length), n));
}

/** Seconds of already-synthesized audio waiting after the current item. */
export function bufferedSeconds(items: BufferItem[]): number {
  let ms = 0;
  for (const item of items) if (item.audioMs !== undefined) ms += item.audioMs;
  return ms / 1000;
}
