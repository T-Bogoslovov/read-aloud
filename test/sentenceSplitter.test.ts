import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, splitText, sentenceSpans } from '../src/text/sentenceSplitter';
import { plainTextToSegments } from '../src/text/plainText';

test('basic sentence boundaries', () => {
  assert.deepEqual(splitText('Hello world. This is a test! Is it? Yes.'), ['Hello world.', 'This is a test!', 'Is it?', 'Yes.']);
});

test('abbreviations, initials, decimals and urls do not split', () => {
  assert.deepEqual(splitText('Dr. Smith met Mr. Jones at 3.5 p.m. on Jan. 5. They left.'), ['Dr. Smith met Mr. Jones at 3.5 p.m. on Jan. 5.', 'They left.']);
  assert.deepEqual(splitText('J. K. Rowling wrote it. See https://example.com/a.b for more. Done.'), ['J. K. Rowling wrote it.', 'See https://example.com/a.b for more.', 'Done.']);
  assert.deepEqual(splitText('Use e.g. apples, i.e. fruit. Then stop.'), ['Use e.g. apples, i.e. fruit.', 'Then stop.']);
});

test('closing quotes stay with the sentence', () => {
  assert.deepEqual(splitText('He said "go." Then "stop!" She left.'), ['He said "go."', 'Then "stop!"', 'She left.']);
});

test('ellipsis and multiple punctuation', () => {
  assert.deepEqual(splitText('Wait... what?! Really.'), ['Wait... what?!', 'Really.']);
  assert.deepEqual(splitText('Wait... What?! Really.'), ['Wait...', 'What?!', 'Really.']);
});

test('lines of a paragraph flow together; blank lines separate blocks', () => {
  const segs = plainTextToSegments(['First line of a', 'sentence that wraps. Second', '', 'New paragraph without period'], { mode: 'paragraphs' });
  const out = splitSentences(segs);
  assert.deepEqual(out.map((s) => s.text), ['First line of a sentence that wraps.', 'Second', 'New paragraph without period']);
  assert.deepEqual(out[0].range, { startLine: 0, startChar: 0, endLine: 1, endChar: 20 });
  assert.deepEqual(out[1].range, { startLine: 1, startChar: 21, endLine: 1, endChar: 27 });
});

test('code mode keeps one line per sentence', () => {
  const segs = plainTextToSegments(['const a = 1;', '  return a. b;'], { mode: 'lines' });
  const out = splitSentences(segs);
  assert.deepEqual(out.map((s) => s.text), ['const a = 1;', 'return a. b;']);
  assert.equal(out[1].range?.startChar, 2, 'leading indentation is skipped in the highlight');
});

test('very long sentences are chunked at clause breaks', () => {
  const long = Array.from({ length: 40 }, (_, i) => `clause number ${i}`).join(', ') + '.';
  const parts = splitText(long, 120);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 120));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long);
});

test('sentenceSpans covers the whole string', () => {
  const s = 'One. Two? Three';
  const spans = sentenceSpans(s);
  assert.equal(spans[0][0], 0);
  assert.equal(spans[spans.length - 1][1], s.length);
});

import { splitForFastStart } from '../src/text/sentenceSplitter';

test('splitForFastStart cuts a long first sentence at a clause break and keeps exact ranges', () => {
  const text = 'This opening sentence is rather long and keeps going, so the lead-in should stop at the comma and the rest follows later.';
  const [lead, rest] = splitForFastStart({ text, range: { startLine: 3, startChar: 4, endLine: 3, endChar: 4 + text.length } });
  assert.equal(lead.text, 'This opening sentence is rather long and keeps going,');
  assert.equal(rest.text, 'so the lead-in should stop at the comma and the rest follows later.');
  assert.deepEqual(lead.range, { startLine: 3, startChar: 4, endLine: 3, endChar: 4 + lead.text.length });
  assert.deepEqual(rest.range, { startLine: 3, startChar: 4 + text.indexOf('so the'), endLine: 3, endChar: 4 + text.length });
});

test('splitForFastStart leaves short sentences and unbreakable text alone', () => {
  assert.equal(splitForFastStart({ text: 'Short one.' }).length, 1);
  assert.equal(splitForFastStart({ text: 'x'.repeat(200) }).length, 1);
  const multi = splitForFastStart({ text: 'A long first line without any punctuation that simply runs on and on and on and on and on until it eventually wraps onto the next line and ends here', range: { startLine: 0, startChar: 0, endLine: 1, endChar: null } });
  assert.equal(multi.length, 2);
  assert.deepEqual(multi[0].range, multi[1].range, 'multi-line ranges are shared rather than guessed');
});
