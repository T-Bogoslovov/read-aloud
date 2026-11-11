import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToSegments, stripInline } from '../src/text/markdownStripper';

test('stripInline removes emphasis, links, code and html', () => {
  assert.equal(stripInline('This is **bold**, *italic*, and `code`.'), 'This is bold, italic, and code.');
  assert.equal(stripInline('See [the docs](https://example.com "t") and ![logo](img.png).'), 'See the docs and logo.');
  assert.equal(stripInline('Ref [link][1] and <b>html</b> &amp; &nbsp;entities'), 'Ref link and html & entities');
  assert.equal(stripInline('snake_case_name stays and _emph_ goes'), 'snake_case_name stays and emph goes');
  assert.equal(stripInline('~~gone~~ kept \\*literal\\*'), 'gone kept *literal*');
  assert.equal(stripInline('Footnote[^1] here'), 'Footnote here');
  assert.equal(stripInline('<https://example.com/x>'), 'https://example.com/x');
});

test('headings, lists, quotes and rules', () => {
  const md = ['# Title', '', 'Para line one', 'continues here.', '', '- item **one**', '- item two', '', '> quoted text', '', '---', '', 'Last.'];
  const segs = markdownToSegments(md);
  assert.deepEqual(segs.map((s) => s.text), ['Title', 'Para line one', 'continues here.', 'item one', 'item two', 'quoted text', 'Last.']);
  assert.equal(segs[0].blockEnd, true, 'heading ends a block');
  assert.equal(segs[1].blockEnd, false, 'paragraph line flows into the next');
  assert.equal(segs[2].blockEnd, true);
  assert.equal(segs[3].blockEnd, true, 'list item ends a block');
  assert.equal(segs[1].exact, true, 'plain paragraph line is verbatim');
  assert.equal(segs[0].exact, false, 'heading text is not verbatim');
  assert.equal(segs[0].line, 0);
  assert.equal(segs[6].line, 12);
});

test('fenced code blocks are announced, skipped or read', () => {
  const md = ['Before', '', '```js', 'const x = 1;', '```', '', 'After'];
  assert.deepEqual(markdownToSegments(md, { codeBlocks: 'announce' }).map((s) => s.text), ['Before', 'Code block skipped.', 'After']);
  assert.deepEqual(markdownToSegments(md, { codeBlocks: 'skip' }).map((s) => s.text), ['Before', 'After']);
  assert.deepEqual(markdownToSegments(md, { codeBlocks: 'read' }).map((s) => s.text), ['Before', 'const x = 1;', 'After']);
  const announced = markdownToSegments(md, { codeBlocks: 'announce' })[1];
  assert.equal(announced.line, 2, 'announcement maps to the opening fence line');
});

test('tables are read row by row', () => {
  const md = ['| Name | Age |', '|------|-----|', '| Ann  | 30  |', '| Bob | 41 |'];
  const segs = markdownToSegments(md);
  assert.deepEqual(segs.map((s) => s.text), ['Table with columns: Name, Age.', 'Ann, 30.', 'Bob, 41.']);
  assert.ok(segs.every((s) => s.blockEnd));
});

test('front matter, reference definitions and setext headings', () => {
  const md = ['---', 'title: x', '---', 'Heading', '=======', '', 'Body [a][ref].', '', '[ref]: https://x.y'];
  const segs = markdownToSegments(md);
  assert.deepEqual(segs.map((s) => s.text), ['Heading', 'Body a.']);
  assert.equal(segs[0].blockEnd, true);
});

test('line offsets are applied', () => {
  const segs = markdownToSegments(['tail of line', 'next'], { lineOffset: 10, firstLineOffset: 5 });
  assert.equal(segs[0].line, 10);
  assert.equal(segs[0].startChar, 5);
  assert.equal(segs[1].line, 11);
  assert.equal(segs[1].startChar, 0);
});

import { collectMarks } from '../src/text/markdownStripper';
import { splitSentences as split2 } from '../src/text/sentenceSplitter';

test('collectMarks finds bold, italic, code and link text', () => {
  const marks = collectMarks('**Equipment:** uses `msdyn_workorder`, see [the docs](http://x) and *maybe* snake_case_name.');
  assert.deepEqual(marks, [
    { text: 'msdyn_workorder', kind: 'code' },
    { text: 'Equipment:', kind: 'bold' },
    { text: 'maybe', kind: 'italic' },
    { text: 'the docs', kind: 'link' },
  ]);
});

test('display hints: block kinds, markers and marks survive sentence splitting; spoken text is unchanged', () => {
  const md = ['## Plan', '', '1. **First:** do this. Then that.', '- plain `code` item', '', '> quoted'];
  const sentences = split2(markdownToSegments(md));
  assert.deepEqual(sentences.map((s) => s.text), ['Plan', 'First: do this.', 'Then that.', 'plain code item', 'quoted']);
  assert.deepEqual(sentences.map((s) => s.block), ['heading', 'numbered', 'numbered', 'bullet', 'quote']);
  assert.equal(sentences[0].level, 2);
  assert.deepEqual(sentences.map((s) => !!s.blockStart), [true, true, false, true, true]);
  assert.equal(sentences[1].marker, '1.');
  assert.equal(sentences[2].marker, undefined, 'only the first sentence of an item carries the marker');
  assert.deepEqual(sentences[1].marks, [{ text: 'First:', kind: 'bold' }]);
  assert.equal(sentences[2].marks, undefined);
  assert.deepEqual(sentences[3].marks, [{ text: 'code', kind: 'code' }]);
});
