import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscriptLine, TranscriptTail, readReplies, slugForPath, locateSelection, findCandidateTranscripts } from '../src/follow/transcriptTail';

const line = (o: unknown) => JSON.stringify(o) + '\n';
const reply = (uuid: string, text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', uuid, timestamp: '2026-11-05T10:00:00Z', isSidechain: false, message: { id: 'msg_1', content: [{ type: 'text', text }] }, ...extra });

test('parseTranscriptLine keeps assistant text and drops everything else', () => {
  assert.equal(parseTranscriptLine(reply('u1', 'Hello **there**'))?.text, 'Hello **there**');
  assert.equal(parseTranscriptLine(line({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })), undefined);
  assert.equal(parseTranscriptLine(line({ type: 'assistant', uuid: 'u3', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })), undefined);
  assert.equal(parseTranscriptLine(reply('u4', 'sub agent', { isSidechain: true })), undefined);
  assert.equal(parseTranscriptLine(line({ type: 'user', message: { content: 'typed prompt' } })), undefined);
  assert.equal(parseTranscriptLine('not json'), undefined);
  assert.equal(parseTranscriptLine(line({ type: 'attachment' })), undefined);
});

test('slugForPath matches Claude Code folder names', () => {
  assert.equal(slugForPath('/home/user'), '-home-user');
  assert.equal(slugForPath('C:\\Users\\x\\proj'), 'C--Users-x-proj');
});

test('TranscriptTail emits only lines appended after start, handles partial lines and truncation', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ra-tail-'));
  const file = path.join(dir, 's.jsonl');
  await fs.promises.writeFile(file, reply('old', 'Old reply'));
  const tail = new TranscriptTail(file, { pollIntervalMs: 100 });
  const got: string[] = [];
  tail.on('reply', (b) => got.push(b.text));
  await tail.start();
  assert.deepEqual(got, [], 'nothing from before start');
  // Append a complete line plus half of another.
  const full = reply('n1', 'First new reply');
  const half = reply('n2', 'Second new reply');
  await fs.promises.appendFile(file, full + half.slice(0, 20));
  await tail.poll();
  assert.deepEqual(got, ['First new reply']);
  await fs.promises.appendFile(file, half.slice(20));
  await tail.poll();
  assert.deepEqual(got, ['First new reply', 'Second new reply']);
  // Same uuid again is ignored; tool_use lines are ignored.
  await fs.promises.appendFile(file, reply('n2', 'dup') + line({ type: 'assistant', uuid: 't', message: { content: [{ type: 'tool_use' }] } }));
  await tail.poll();
  assert.equal(got.length, 2);
  // Truncation: file rewritten shorter -> restart from 0.
  await fs.promises.writeFile(file, reply('r1', 'After rewrite'));
  await tail.poll();
  assert.deepEqual(got.slice(-1), ['After rewrite']);
  tail.stop();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('readReplies returns blocks with end offsets usable as a tail start', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ra-read-'));
  const file = path.join(dir, 's.jsonl');
  const a = reply('a', 'Alpha reply.');
  const b = reply('b', 'Beta reply with café.');
  await fs.promises.writeFile(file, a + line({ type: 'user', message: { content: 'x' } }) + b);
  const blocks = await readReplies(file);
  assert.deepEqual(blocks.map((x) => x.text), ['Alpha reply.', 'Beta reply with café.']);
  assert.equal(blocks[1].endOffset, Buffer.byteLength(a + line({ type: 'user', message: { content: 'x' } }) + b));
  const tail = new TranscriptTail(file, { fromOffset: blocks[0].endOffset });
  const got: string[] = [];
  tail.on('reply', (x) => got.push(x.text));
  await tail.poll();
  assert.deepEqual(got, ['Beta reply with café.'], 'tailing from after block A yields block B');
  tail.stop();
  assert.equal((await readReplies(file, 1)).length, 1);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('locateSelection finds copied chat text despite markdown and whitespace differences', () => {
  const blocks = [
    { uuid: '1', text: 'Earlier paragraph about something else entirely.', timestamp: '', endOffset: 1 },
    { uuid: '2', text: '**Equipment:** AC1 names only the MP FLOC, so matching by MP Equipment is out.\n\nBooking Dates are grouped by Plan.', timestamp: '', endOffset: 2 },
  ];
  const hit = locateSelection(blocks, 'Equipment: AC1 names only the MP FLOC,  so matching');
  assert.equal(hit?.index, 1);
  assert.ok((hit?.charOffset ?? 99) < 5);
  const later = locateSelection(blocks, 'Booking Dates are grouped by Plan');
  assert.equal(later?.index, 1);
  assert.ok((later?.charOffset ?? 0) > 60);
  assert.equal(locateSelection(blocks, 'text that is nowhere in the transcript at all'), undefined);
});

test('findCandidateTranscripts ranks workspace matches first, then newest', async () => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ra-proj-'));
  await fs.promises.mkdir(path.join(base, '-home-user'));
  await fs.promises.mkdir(path.join(base, '-other'));
  await fs.promises.writeFile(path.join(base, '-other', 'new.jsonl'), '');
  await fs.promises.writeFile(path.join(base, '-home-user', 'old.jsonl'), '');
  const old = new Date(Date.now() - 60_000);
  await fs.promises.utimes(path.join(base, '-home-user', 'old.jsonl'), old, old);
  const list = await findCandidateTranscripts(base, ['-home-user']);
  assert.deepEqual(list.map((c) => path.basename(c.file)), ['old.jsonl', 'new.jsonl']);
  await fs.promises.rm(base, { recursive: true, force: true });
});

test('progress summaries (thinking blocks with text) are read only when enabled', () => {
  const summary = line({ type: 'assistant', uuid: 's1', isSidechain: false, message: { content: [{ type: 'thinking', thinking: 'The form is saved, publishing next.' }] } });
  const priv = line({ type: 'assistant', uuid: 's2', isSidechain: false, message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] } });
  assert.equal(parseTranscriptLine(summary), undefined);
  assert.equal(parseTranscriptLine(summary, 0, true)?.text, 'The form is saved, publishing next.');
  assert.equal(parseTranscriptLine(priv, 0, true), undefined);
});
