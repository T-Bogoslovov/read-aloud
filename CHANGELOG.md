# Changelog

## 0.3.2 — 2026-11-11

- Compact mini player: one or two lines of the current sentence, a single control row (previous, play/pause, stop, next, speed, voice with preview) and a status line. The chevron in the header expands the text to a few sentences. Everything else (output, engine, quick actions, options, benchmark) is under "Settings and more".
- The text view keeps the source formatting: headings, bullets and numbering, quotes, bold, italic, inline code and link text, with the current sentence highlighted and click-to-jump.
- Fixed: the "Sound needs one click" note was always visible, even while audio played. Fixed: pressing Play to enable sound started and immediately paused playback. The second audio element is now primed by the same gesture, so the next sentence no longer needs another press.
- Highlighting inside Claude's own chat is not possible: VS Code gives extensions no access to another extension's view.

## 0.3.1 — 2026-11-10

- Follow Claude can also read the short progress summaries shown between tool calls (lines marked "summary" in the chat). On by default; toggle under Options in the panel or with `readAloud.follow.readSummaries`. Changing it applies the next time Follow is started.

## 0.3.0 — 2026-11-10

- The "browser blocked automatic playback" warning is gone. When VS Code requires a gesture, a calm note explains it, the panel takes focus, and any click or key press (Space) starts the sound. New **Output** choice: *System audio* plays through the operating system and never needs a click (pause restarts the sentence; speed applies to upcoming sentences). Setting: `readAloud.output`.
- The panel now shows the whole text being read with the current sentence highlighted and kept in view; click any sentence to jump to it.
- Fixed: Read Selection on a Claude Code tab failed with "command 'editor.action.webvieweditor.copy' not found". It now restores focus to the chat and uses the standard copy action, and if nothing is selected it reads Claude's latest reply from the transcript.

## 0.2.2 — 2026-11-05

- New defaults tuned for laptops where synthesis is only slightly faster than playback: `readAloud.bufferSeconds` 40 (was 20) and `readAloud.maxSentenceLength` 140 (was 180). Explicit user settings still take precedence.

## 0.2.1 — 2026-11-05

- Clear progress: the panel and status bar now say what is happening: downloading (with percent), starting the voice engine, loading the model, warming up, then "Buffered N s ahead · synthesizing M more · speed X× real time". When playback has to wait for synthesis, a ticking message says so and points to the benchmark.
- Fewer gaps: sentences are synthesized ahead by time (`readAloud.bufferSeconds`, default 20 s; doubled automatically on slow machines) instead of a fixed two sentences, so the engine never idles while there is text left; a Follow reply is queued in full on arrival.
- Faster first sentence: the engine runs a warm-up inference while loading, so the first real sentence no longer pays the one-off initialisation cost.
- New **Read Aloud: Benchmark Voice Speed** (also in the panel's Options): measures synthesis speed on your CPU, can download and measure the 8-bit model, and offers to switch to the faster one. A one-time hint appears when synthesis is measured slower than playback.
- Kokoro helper stays loaded for 30 idle minutes by default; new `readAloud.kokoro.threads` setting.

## 0.2.0 — 2026-11-05

- **Follow Claude**: `Ctrl+Alt+L` (or the broadcast button on a Claude Code tab, or the panel button) reads Claude Code's replies aloud as they appear, by tailing the session transcript Claude Code writes under `~/.claude/projects`. Two start modes: *From now on* and *From my selection* (select or copy text in the chat; reading starts there and continues with everything new). The player waits between replies instead of finishing; Stop ends the follow.
- New settings `readAloud.follow.transcriptsDirectory`, `readAloud.follow.pollIntervalMs`, `readAloud.follow.announceStart`.

## 0.1.7 — 2026-11-05

Performance release.

- Gapless playback: the next sentence is preloaded into a second audio element, so the webview switches instantly on its own instead of waiting for a round trip through the extension host.
- Audio now travels as binary (structured-clone IPC from the helper, ArrayBuffer to the webview, Blob URL in the player) instead of base64 strings and `data:` URIs; the extension host no longer converts samples back and forth.
- Faster start: the first sentence of a session is split at a clause break (about 110 characters) so sound begins sooner, and the default chunk length dropped from 300 to 180 characters, which also shortens the wait after Stop, Skip and voice changes.
- The Kokoro helper stays alive for 45 minutes of inactivity (was 15) and this is configurable with `readAloud.kokoro.keepAliveMinutes` (0 = never shut down); model files are checked on disk once per session instead of per sentence.
- Interrupted model downloads resume instead of restarting from zero.
- Read PDF Aloud parses the document once (page count and extraction share one helper process).
- Sentence splitting uses compact numeric arrays instead of one object per character, so Read Whole File on large documents no longer stalls the editor.
- Fixed: a decode failure in the player was reported as "autoplay blocked"; only real autoplay blocks show that banner now.
- Fixed: only the first run of repeated spaces was collapsed during English text normalization.
- Removed dead code (unused helpers, non-English voice samples, redundant registrations).

## 0.1.6 — 2026-11-05

- Redesigned player panel: voice dropdown with Preview button, engine switch, Kokoro speaking-rate slider, six quick-action buttons (selection, cursor, whole file, clipboard, PDF, test voice), an Options drawer (stop on file switch, PDF page numbers, code blocks) and a progress bar for the current session. Changing a voice in the dropdown plays a sample and saves the setting.
- Accessibility: all controls are real buttons, selects and labelled inputs with 44 px targets and visible focus rings; −/+ buttons for speed; the panel adapts down to sidebar width.

## 0.1.5 — 2026-11-05

- Voice list limited to the 28 English Kokoro voices. The bundled phonemizer ships English speech data only, so the Spanish, French, Hindi, Italian, Japanese, Portuguese and Mandarin voices produced an error; they are removed until multilingual phoneme data can be bundled.

## 0.1.4 — 2026-11-05

- **Select Voice** now plays a sample of the highlighted voice as you move through the list (Enter saves, Escape keeps the current voice). Samples are in each voice's own language.
- Voice list shows language, gender and a quality hint; the system-voice picker runs Test Voice after saving.
- Fixed: concurrent commands during the first download no longer start the download twice.

## 0.1.3 — 2026-11-05

- Read Selection now works in webview tabs such as Claude's chat, Markdown previews and other extensions' panels: the selection is captured through the clipboard. If nothing is selected, the current clipboard text is read.
- New command **Read Aloud: Read Clipboard Text**.
- `Ctrl+Alt+R` works everywhere, not only when a text editor has focus, and the sound button also appears on webview tabs.

## 0.1.2 — 2026-11-04

- Fixed: "nothing to read" when using the Read Selection button on a Markdown preview editor while a text editor of the same file had its cursor at the end. Preview editors now read the whole file; a cursor at the end of a file reads from the top.

## 0.1.1 — 2026-11-04

- Fixed: reading stopped immediately with "Stopped (switched file)" when the player panel opened or when the file was open in a Markdown preview editor. File switches are now detected from the active tab with a short grace period.
- Files open in a custom editor (Markdown preview editors, WYSIWYG Markdown editors) can now be read: the whole file is read since no text selection is available there.
- New command **Read Aloud: Test Voice** speaks a test sentence so you can check audio and the chosen voice.
- Pressing Play in the panel while nothing is loaded reads the current selection or file.
- Closing the file's tab stops reading; previously any closed document could.

## 0.1.0 — 2026-11-04

Initial release.

- Read Selection, Read From Cursor, Read Whole File, Pause/Resume, Stop, Faster, Slower commands with keybindings and editor context-menu entries.
- Kokoro neural voice (default) running fully offline through onnxruntime-node after a one-time model download.
- Operating-system voice fallback: `say` on macOS, System.Speech on Windows, espeak-ng on Linux.
- Optional Piper provider using a locally installed `piper` executable.
- Markdown-aware reading: headings, emphasis, links (link text only), inline code, images (alt text), tables row by row, code blocks announced/skipped/read.
- Plain text paragraphs flow across line breaks; code files are read line by line.
- "Read PDF Aloud" command with page-range selection, paragraph detection and hyphenation repair.
- Playback panel with play/pause/stop, previous/next sentence, speed slider; the current sentence is highlighted in the editor.
- Sentences are synthesized ahead of playback so there is no long pause between them.
