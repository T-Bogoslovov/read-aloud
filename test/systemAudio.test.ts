import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePlayer, parseCustomCommand, PS_PLAYER_SCRIPT } from '../src/player/systemAudio';

test('choosePlayer picks the platform player', () => {
  assert.deepEqual(choosePlayer('darwin', () => false, 'a.wav'), { command: 'afplay', args: ['a.wav'], label: 'afplay' });
  assert.equal(choosePlayer('linux', (b) => b === 'ffplay', 'a.wav')?.label, 'ffplay');
  assert.equal(choosePlayer('linux', (b) => b === 'aplay' || b === 'ffplay', 'a.wav')?.label, 'aplay');
  assert.equal(choosePlayer('linux', () => false, 'a.wav'), undefined);
  assert.equal(choosePlayer('win32', () => true, 'a.wav'), undefined, 'Windows uses the PowerShell helper instead');
});

test('parseCustomCommand substitutes the file and appends it when missing', () => {
  assert.deepEqual(parseCustomCommand('mpv --no-video {file}', '/x/y.wav'), { command: 'mpv', args: ['--no-video', '/x/y.wav'], label: 'mpv' });
  assert.deepEqual(parseCustomCommand('play', 'f.wav')?.args, ['f.wav']);
  assert.equal(parseCustomCommand('   ', 'f.wav'), undefined);
});

test('the PowerShell helper script reads PLAY lines and answers DONE', () => {
  assert.ok(PS_PLAYER_SCRIPT.includes('System.Media.SoundPlayer'));
  assert.ok(PS_PLAYER_SCRIPT.includes("StartsWith('PLAY ')"));
  assert.ok(PS_PLAYER_SCRIPT.includes("WriteLine('DONE')"));
  assert.ok(PS_PLAYER_SCRIPT.includes('QUIT'));
});
