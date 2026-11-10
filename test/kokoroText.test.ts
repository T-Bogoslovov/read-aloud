import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnglish, tokenizePhonemes, chunkPhonemes, langForVoice, textToPhonemes } from '../src/tts/kokoroText';

test('english normalization expands money, times and titles', () => {
  assert.equal(normalizeEnglish('Dr. Smith paid $3.50 at 10:30.'), 'Doctor Smith paid 3 dollars and 50 cents at 10 30.');
  assert.equal(normalizeEnglish('In 1999 and 2015'), 'In 19 99 and 20 15');
  assert.equal(normalizeEnglish('Pi is 3.14'), 'Pi is 3 point 1 4');
});

test('tokenize drops unknown symbols', () => {
  const vocab = { a: 1, b: 2, ' ': 3 };
  assert.deepEqual(tokenizePhonemes('ab xa', vocab), [1, 2, 3, 1]);
});

test('chunkPhonemes respects the token limit', () => {
  const vocab: Record<string, number> = { a: 1, ' ': 2, '.': 3, ',': 4 };
  const ph = Array.from({ length: 30 }, () => 'aaaa aaaa,').join(' ');
  const chunks = chunkPhonemes(ph, vocab, 40);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => tokenizePhonemes(c, vocab).length <= 40));
});

test('language is derived from the voice prefix', () => {
  assert.equal(langForVoice('af_heart'), 'a');
  assert.equal(langForVoice('bm_fable'), 'b');
  assert.equal(langForVoice('ff_siwis'), 'a', 'non-English voices fall back to English phonemization');
  assert.equal(langForVoice('unknown'), 'a');
});

test('punctuation is preserved around phonemized words', async () => {
  const fake = async (t: string) => [t.trim().split(/\s+/).map((w) => `<${w}>`).join(' ')];
  const ph = await textToPhonemes('Hello, world! Yes.', 'a', fake);
  assert.equal(ph, '<Hello>, <woɹld>! <Yes>.', 'r is normalized to the IPA ɹ as in kokoro-js');
});

test('all runs of repeated spaces are collapsed', () => {
  assert.equal(normalizeEnglish('a  b   c    d'), 'a b c d');
});
