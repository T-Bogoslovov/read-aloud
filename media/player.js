// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const title = $('title'), counter = $('counter'), sentence = $('sentence'), status = $('status'), blocked = $('blocked');
  const toggle = $('toggle'), rate = $('rate'), rateLabel = $('rateLabel'), bar = $('bar');
  const voice = $('voice'), engine = $('engine'), kspeed = $('kspeed'), kspeedLabel = $('kspeedLabel');
  const optStop = $('optStop'), optPages = $('optPages'), optCode = $('optCode'), options = $('options'), footer = $('footer');

  // Two audio elements: one plays while the next sentence is already decoded in the other.
  const players = [/** @type {HTMLAudioElement} */ ($('audio')), /** @type {HTMLAudioElement} */ ($('audio2'))];
  const urls = ['', ''];
  let cur = 0;
  let currentIndex = -1;
  /** @type {{index:number,total:number,text:string,page?:number}|null} */
  let preloaded = null;
  let hasAudio = false;
  let stopped = true;
  let suppress = false; // true while we fill controls from a config message
  let soundBlocked = false; // waiting for the one user gesture Chromium requires
  let justUnblocked = false;
  const output = $('output');

  const active = () => players[cur];

  function setSource(slot, bytes) {
    if (urls[slot]) URL.revokeObjectURL(urls[slot]);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    urls[slot] = url;
    const el = players[slot];
    el.src = url;
    el.playbackRate = parseFloat(rate.value);
    el.load();
  }

  function clearSource(slot) {
    const el = players[slot];
    el.pause();
    el.removeAttribute('src');
    el.load();
    if (urls[slot]) { URL.revokeObjectURL(urls[slot]); urls[slot] = ''; }
  }

  function setRate(value, notify) {
    const r = Math.max(0.5, Math.min(3, Math.round(value * 10) / 10));
    for (const el of players) { el.playbackRate = r; el.defaultPlaybackRate = r; }
    rate.value = String(r);
    rateLabel.textContent = r.toFixed(1) + '×';
    if (notify) vscode.postMessage({ type: 'rate', rate: r });
  }

  function setPlayingUi(playing) {
    toggle.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
    toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    toggle.title = playing ? 'Pause (Ctrl+Alt+P)' : 'Play (Ctrl+Alt+P)';
  }

  async function tryPlay() {
    const el = active();
    try {
      await el.play();
      blocked.hidden = true;
      vscode.postMessage({ type: 'playstate', playing: true });
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotAllowedError') {
        // Autoplay policy: needs one user gesture inside this document. Any click or key will do.
        soundBlocked = true;
        blocked.hidden = false;
        setPlayingUi(false);
        try { $('enableSound').focus(); } catch {}
        vscode.postMessage({ type: 'playstate', playing: false, blocked: true });
      } else if (name !== 'AbortError') {
        vscode.postMessage({ type: 'error', message: 'Audio could not be played (' + (name || 'unknown error') + ')' });
      }
    }
  }

  const script = $('script');
  let spans = [];
  let curSpan = -1;
  function addScript(texts) {
    for (const t of texts) {
      const el = document.createElement('span');
      el.textContent = t + ' ';
      const i = spans.length;
      el.addEventListener('click', () => vscode.postMessage({ type: 'seek', index: i }));
      script.appendChild(el);
      spans.push(el);
    }
    script.classList.toggle('on', spans.length > 0);
  }
  function setScript(texts) { script.textContent = ''; spans = []; curSpan = -1; addScript(texts); }
  /** Highlight the sentence being read and keep it in view. */
  function markCurrent(index) {
    if (!spans.length || index === curSpan) return;
    const from = Math.min(curSpan < 0 ? 0 : curSpan, index), to = Math.max(curSpan, index);
    for (let i = from; i <= to && i < spans.length; i++) { spans[i].classList.toggle('done', i < index); spans[i].classList.remove('cur'); }
    if (spans[index]) {
      spans[index].classList.add('cur');
      const el = spans[index];
      const top = el.offsetTop - script.offsetTop;
      if (top < script.scrollTop + 20 || top + el.offsetHeight > script.scrollTop + script.clientHeight - 20) script.scrollTop = Math.max(0, top - script.clientHeight / 3);
    }
    curSpan = index;
  }

  function showSentence(index, total, text, page) {
    markCurrent(index);
    counter.textContent = total ? (index + 1) + ' / ' + total + (page ? ' · page ' + page : '') : '';
    bar.style.width = total ? Math.round(((index + 1) / total) * 100) + '%' : '0%';
    sentence.textContent = text;
  }

  players.forEach((el, slot) => {
    el.addEventListener('ended', () => {
      if (slot !== cur || stopped) return;
      if (preloaded && preloaded.index === currentIndex + 1) {
        // Gapless switch to the sentence that is already decoded in the other element.
        const next = preloaded;
        preloaded = null;
        cur = 1 - cur;
        currentIndex = next.index;
        showSentence(next.index, next.total, next.text, next.page);
        status.textContent = '';
        void tryPlay();
        vscode.postMessage({ type: 'started', index: next.index });
      } else {
        vscode.postMessage({ type: 'ended', index: currentIndex });
      }
    });
    el.addEventListener('play', () => { if (slot === cur) setPlayingUi(true); });
    el.addEventListener('pause', () => { if (slot === cur && !stopped) setPlayingUi(false); });
    el.addEventListener('error', () => { if (slot === cur && hasAudio) vscode.postMessage({ type: 'error', message: 'Audio could not be decoded' }); });
  });

  // The gesture that unblocks sound: any pointer or key event in the panel.
  function onGesture(e) {
    if (!soundBlocked) return;
    soundBlocked = false;
    blocked.hidden = true;
    justUnblocked = true;
    setTimeout(() => { justUnblocked = false; }, 0);
    if (e && e.type === 'keydown' && e.key === ' ') e.preventDefault();
    if (hasAudio && active().paused) void tryPlay();
  }
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  $('enableSound').addEventListener('click', () => { if (hasAudio && active().paused) void tryPlay(); });
  $('useSystemAudio').addEventListener('click', () => {
    vscode.postMessage({ type: 'setting', key: 'output', value: 'system' });
    vscode.postMessage({ type: 'restart' });
  });

  toggle.addEventListener('click', () => {
    if (justUnblocked) return;
    if (!hasAudio) { vscode.postMessage({ type: 'toggle' }); return; }
    if (active().paused) { void tryPlay(); }
    else { active().pause(); vscode.postMessage({ type: 'playstate', playing: false }); }
  });
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('prev').addEventListener('click', () => vscode.postMessage({ type: 'skip', delta: -1 }));
  $('next').addEventListener('click', () => vscode.postMessage({ type: 'skip', delta: 1 }));
  $('slower').addEventListener('click', () => setRate(parseFloat(rate.value) - 0.1, true));
  $('faster').addEventListener('click', () => setRate(parseFloat(rate.value) + 0.1, true));
  rate.addEventListener('input', () => setRate(parseFloat(rate.value), true));

  // Voice & engine
  voice.addEventListener('change', () => { if (suppress) return; vscode.postMessage({ type: 'setting', key: 'kokoro.voice', value: voice.value }); vscode.postMessage({ type: 'previewVoice', voice: voice.value }); });
  $('preview').addEventListener('click', () => vscode.postMessage({ type: 'previewVoice', voice: voice.value }));
  engine.addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'provider', value: engine.value }); });
  output.addEventListener('change', () => { if (suppress) return; vscode.postMessage({ type: 'setting', key: 'output', value: output.value }); vscode.postMessage({ type: 'restart' }); });
  kspeed.addEventListener('input', () => { kspeedLabel.textContent = parseFloat(kspeed.value).toFixed(1); });
  kspeed.addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'kokoro.speed', value: parseFloat(kspeed.value) }); });

  // Quick actions
  document.querySelectorAll('[data-command]').forEach((el) => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'command', id: el.getAttribute('data-command') }));
  });

  // Options
  $('optionsToggle').addEventListener('click', () => {
    const collapsed = options.classList.toggle('collapsed');
    $('optionsToggle').setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('readAloud.optionsCollapsed', collapsed ? '1' : '0'); } catch {}
  });
  try { if (localStorage.getItem('readAloud.optionsCollapsed') === '1') { options.classList.add('collapsed'); $('optionsToggle').setAttribute('aria-expanded', 'false'); } } catch {}
  optStop.addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'stopOnEditorChange', value: optStop.checked }); });
  optPages.addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'pdf.announcePages', value: optPages.checked }); });
  $('optSummaries').addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'follow.readSummaries', value: $('optSummaries').checked }); });
  optCode.addEventListener('change', () => { if (!suppress) vscode.postMessage({ type: 'setting', key: 'markdown.codeBlocks', value: optCode.value }); });

  window.addEventListener('keydown', (e) => {
    if (justUnblocked) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON');
    if (typing) return;
    if (e.key === ' ') { e.preventDefault(); toggle.click(); }
    if (e.key === 'ArrowRight') vscode.postMessage({ type: 'skip', delta: 1 });
    if (e.key === 'ArrowLeft') vscode.postMessage({ type: 'skip', delta: -1 });
  });

  function applyConfig(c) {
    suppress = true;
    try {
      if (Array.isArray(c.voices)) {
        voice.innerHTML = '';
        for (const v of c.voices) {
          const o = document.createElement('option');
          o.value = v.id; o.textContent = v.label; voice.appendChild(o);
        }
      }
      if (c.voice) voice.value = c.voice;
      if (c.provider) engine.value = c.provider;
      if (c.output) { output.value = c.output; if (c.output === 'system') { blocked.hidden = true; soundBlocked = false; } }
      if (typeof c.kokoroSpeed === 'number') { kspeed.value = String(c.kokoroSpeed); kspeedLabel.textContent = c.kokoroSpeed.toFixed(1); }
      if (typeof c.stopOnEditorChange === 'boolean') optStop.checked = c.stopOnEditorChange;
      if (typeof c.announcePages === 'boolean') optPages.checked = c.announcePages;
      if (c.codeBlocks) optCode.value = c.codeBlocks;
      if (typeof c.readSummaries === 'boolean') $('optSummaries').checked = c.readSummaries;
      const kokoroOnly = c.provider === 'kokoro';
      voice.disabled = !kokoroOnly; kspeed.disabled = !kokoroOnly;
      if (c.footer) footer.querySelector('span.text').textContent = c.footer;
      const follow = $('follow');
      if (follow) {
        follow.classList.toggle('active', !!c.following);
        follow.querySelector('span').textContent = c.following ? 'Stop following' : 'Follow Claude';
        follow.title = c.following ? 'Stop reading Claude Code replies (Ctrl+Alt+L)' : 'Read Claude Code replies as they appear (Ctrl+Alt+L)';
      }
      $('live').hidden = !c.following;
    } finally { suppress = false; }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'load': {
        // Host-driven load (start, skip, or no preload was ready). Anything preloaded for a
        // different position is stale.
        stopped = false; hasAudio = true;
        if (preloaded && preloaded.index !== msg.index + 1) { preloaded = null; clearSource(1 - cur); }
        active().pause();
        setSource(cur, msg.wav);
        currentIndex = msg.index;
        title.textContent = msg.title || '';
        showSentence(msg.index, msg.total, msg.text, msg.page);
        status.textContent = '';
        if (msg.autoplay) void tryPlay();
        break;
      }
      case 'preload': {
        if (stopped || msg.index !== currentIndex + 1) break;
        setSource(1 - cur, msg.wav);
        preloaded = { index: msg.index, total: msg.total, text: msg.text, page: msg.page };
        break;
      }
      case 'sentence':
        showSentence(msg.index, msg.total, msg.text, msg.page);
        break;
      case 'pause': active().pause(); break;
      case 'resume': if (hasAudio) void tryPlay(); break;
      case 'stop':
        stopped = true; hasAudio = false; preloaded = null; soundBlocked = false;
        clearSource(0); clearSource(1);
        status.textContent = msg.text || 'Stopped.';
        blocked.hidden = true;
        setPlayingUi(false);
        break;
      case 'rate': setRate(msg.rate, false); break;
      case 'playing': setPlayingUi(!!msg.playing); break;
      case 'script': setScript(msg.texts || []); break;
      case 'append': addScript(msg.texts || []); break;
      case 'status':
        status.textContent = msg.text || '';
        if (msg.title) title.textContent = msg.title;
        if (typeof msg.index === 'number' && typeof msg.total === 'number') showSentence(msg.index, msg.total, sentence.textContent || '', undefined);
        break;
      case 'config': applyConfig(msg); break;
    }
  });

  setPlayingUi(false);
  vscode.postMessage({ type: 'ready' });
})();
