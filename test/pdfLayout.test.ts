import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinesFromItems, dehyphenate } from '../src/pdf/pdfLayout';

test('items on one baseline join into a line; big gaps become blank lines', () => {
  const lines = extractLinesFromItems([
    { str: 'Hello', x: 72, y: 700, width: 30, height: 12, hasEOL: false },
    { str: 'world', x: 110, y: 700, width: 30, height: 12, hasEOL: true },
    { str: 'Second line', x: 72, y: 686, width: 60, height: 12, hasEOL: true },
    { str: 'New paragraph', x: 72, y: 640, width: 70, height: 12, hasEOL: true },
  ]);
  assert.deepEqual(lines, ['Hello world', 'Second line', '', 'New paragraph']);
});

test('dehyphenate repairs words split across lines', () => {
  assert.deepEqual(dehyphenate(['an exam-', 'ple of text', '', 'next']), ['an example of text', '', 'next']);
  assert.deepEqual(dehyphenate(['well-known phrase']), ['well-known phrase']);
});
