// Beat Lab UI. The server owns the state; this file renders whatever it sends and turns
// clicks into actions. Claude's edits arrive the same way, so the grid always shows the
// pattern both of you are working on.

import { INSTRUMENTS } from '/shared/instruments.js';
import { DrumEngine } from './audio.js';
import { createKnob } from './knob.js';
import { initWindows } from './windows.js';

const VELOCITY = { normal: 0.8, accent: 1, ghost: 0.45 };
const SUBDIVISIONS = { 1: 'quarters', 2: '8ths', 3: 'triplets', 4: '16ths', 5: 'quintuplets', 6: '16th triplets', 7: 'septuplets', 8: '32nds' };
// Counting syllables shown above the grid ("1 e + a"), a common way to teach subdivisions.
const COUNTS = { 2: ['+'], 3: ['+', 'a'], 4: ['e', '+', 'a'] };
const instruments = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i]));

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const engine = new DrumEngine();
const rows = new Map();
const touchedAt = new Map();

let state = null;
let activity = [];
let meta = {};
let socket = null;
let retries = 0;
let gridSignature = '';
let paint = null;

// --- connection --------------------------------------------------------------

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => {
    retries = 0;
    setConnected(true);
    reportAudio();
  };
  socket.onclose = () => {
    setConnected(false);
    setTimeout(connect, Math.min(5000, 250 * 2 ** retries++));
  };
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'error') toast(msg.message);
    if (msg.type === 'sync') applySync(msg);
  };
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

const act = (name, args = {}, stroke) => send({ type: 'action', name, args, stroke });
const reportAudio = () => send({ type: 'audio', ready: engine.ready });

function setConnected(on) {
  $('conn-dot').classList.toggle('on', on);
  $('conn-text').textContent = on ? 'Connected' : 'Reconnecting…';
}

function applySync(msg) {
  const previous = state;
  state = msg.state;
  activity = msg.activity;
  meta = msg.meta;
  renderGrid(previous, msg.source);
  renderLoopIndicator(previous);
  renderTransport();
  renderNote(previous);
  renderActivity();
  renderClaudeStatus();
  syncPlayback();
}

// --- audio -------------------------------------------------------------------

async function unlockAudio() {
  if (engine.ready) return;
  try {
    await engine.unlock();
  } catch (err) {
    console.warn('Could not start audio', err);
  }
  reportAudio();
  syncPlayback();
}

function syncPlayback() {
  if (!state) return renderAudioChip();
  if (state.playing && engine.ready && !engine.running) engine.start(() => state);
  else if (!state.playing && engine.running) engine.stop();
  $('play').classList.toggle('playing', state.playing);
  $('play').setAttribute('aria-label', state.playing ? 'Stop' : 'Play');
  renderAudioChip();
}

function renderAudioChip() {
  const chip = $('audio-chip');
  const urgent = !engine.ready && !!state?.playing;
  chip.hidden = engine.ready;
  chip.classList.toggle('urgent', urgent);
  chip.textContent = urgent ? 'Playing, but audio is off. Click to hear it' : 'Audio off. Click to enable';
}

const isAudible = (track, anySolo) => !track.mute && (!anySolo || track.solo);

engine.onStep = (step) => {
  for (const node of grid.querySelectorAll('.now')) node.classList.remove('now');
  $('position').value = step < 0 ? '–.–' : `${Math.floor(step / state.stepsPerBeat) + 1}.${(step % state.stepsPerBeat) + 1}`;
  if (step < 0) return;
  for (const node of grid.querySelectorAll(`[data-step="${step}"]`)) node.classList.add('now');
  const anySolo = state.tracks.some((t) => t.solo);
  for (const track of state.tracks) {
    if (track.steps[step] > 0 && isAudible(track, anySolo)) flash(rows.get(track.id)?.led, 'hit');
  }
};

function audition(track, velocity = VELOCITY.normal) {
  engine.trigger(track.instrument, undefined, velocity * track.volume);
}

// --- grid --------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function beatGroups(makeItem) {
  const { length, stepsPerBeat: spb } = state;
  const groups = [];
  for (let b = 0; b * spb < length; b++) {
    const beat = el('div', b % 2 ? 'beat alt' : 'beat');
    for (let i = b * spb; i < Math.min(length, (b + 1) * spb); i++) {
      const item = makeItem(i, b);
      item.dataset.step = i;
      beat.append(item);
    }
    groups.push(beat);
  }
  return groups;
}

function buildGrid() {
  grid.replaceChildren();
  rows.clear();

  const ruler = el('div', 'row ruler');
  const ticks = el('div', 'cells');
  ticks.append(
    ...beatGroups((i, b) => {
      const pos = i % state.stepsPerBeat;
      const tick = el('div', pos === 0 ? 'tick downbeat' : 'tick');
      tick.append(el('span', 'led'), el('span', 'count', pos === 0 ? String(b + 1) : (COUNTS[state.stepsPerBeat]?.[pos - 1] ?? '·')));
      return tick;
    }),
  );
  ruler.append(el('div', 'track-head'), ticks);
  grid.append(ruler);

  for (const track of state.tracks) {
    const inst = instruments[track.instrument];
    const row = el('div', 'row');
    row.dataset.track = track.id;
    row.style.setProperty('--c', inst.color);

    const mute = el('button', 'mute-led');
    mute.title = 'Mute';
    const solo = el('button', 'solo-btn', 'S');
    solo.title = 'Solo';
    const volume = createKnob({
      min: 0,
      max: 1,
      value: track.volume,
      defaultValue: 0.8,
      size: 'sm',
      label: `${track.name} volume`,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => act('setTrack', { track: track.id, volume: v }, `vol:${track.id}`),
    });
    volume.el.style.setProperty('--arc', inst.color);
    const name = el('button', 'name-btn');
    const nameText = el('span', 'name-text');
    const led = el('span', 'hit-led');
    name.append(nameText, led);
    name.title = `${inst.name}: press to hear it`;
    const remove = el('button', 'rm', '×');
    remove.title = 'Remove track';
    remove.setAttribute('aria-label', `Remove ${track.name}`);

    const head = el('div', 'track-head');
    head.append(mute, solo, volume.el, name, remove);

    const cellBox = el('div', 'cells');
    const cells = [];
    cellBox.append(
      ...beatGroups(() => {
        const cell = el('div', 'cell');
        cells.push(cell);
        return cell;
      }),
    );

    row.append(head, cellBox);
    grid.append(row);
    rows.set(track.id, { row, mute, solo, volume, nameText, led, cells });
  }
}

function renderGrid(previous, source) {
  const signature = JSON.stringify([state.length, state.stepsPerBeat, state.tracks.map((t) => [t.id, t.instrument])]);
  if (signature !== gridSignature) {
    buildGrid();
    gridSignature = signature;
  }

  const anySolo = state.tracks.some((t) => t.solo);
  const highlighted = new Set((state.note?.highlights ?? []).flatMap((h) => h.steps.map((s) => `${h.track}:${s}`)));

  for (const track of state.tracks) {
    const r = rows.get(track.id);
    const before = previous?.tracks.find((t) => t.id === track.id);
    r.nameText.textContent = track.name;
    r.mute.classList.toggle('muted', track.mute);
    r.mute.setAttribute('aria-pressed', track.mute);
    r.mute.title = track.mute ? 'Unmute' : 'Mute';
    r.solo.classList.toggle('on', track.solo);
    r.solo.setAttribute('aria-pressed', track.solo);
    r.row.classList.toggle('silent', !isAudible(track, anySolo));
    r.volume.set(track.volume);

    r.cells.forEach((cell, i) => {
      const v = track.steps[i];
      cell.classList.toggle('on', v > 0);
      cell.classList.toggle('accent', v >= 0.9);
      cell.style.setProperty('--v', v);
      cell.classList.toggle('hl', highlighted.has(`${track.id}:${i}`));
      // Make Claude's edits easy to spot.
      if (source === 'claude' && previous && (before?.steps[i] ?? 0) !== v) flash(cell);
    });
  }

  $('seq-meta').textContent =
    `${state.tracks.length} tracks · ${state.length} steps · ${SUBDIVISIONS[state.stepsPerBeat] ?? `${state.stepsPerBeat}/beat`}`;
}

function flash(node, className = 'flash') {
  if (!node) return;
  node.classList.remove(className);
  void node.offsetWidth; // restart the animation
  node.classList.add(className);
  node.addEventListener('animationend', () => node.classList.remove(className), { once: true });
}

const trackOf = (node) => state.tracks.find((t) => t.id === node.closest('.row').dataset.track);

// Left-click toggles a step and left-drag paints; right-click erases and right-drag
// erases everything it passes over. One drag is one undo step.
grid.addEventListener('pointerdown', (e) => {
  const name = e.target.closest('.name-btn');
  if (name && e.button === 0) {
    audition(trackOf(name));
    flash(name, 'pressed');
    return;
  }

  const cell = e.target.closest('.cell');
  if (!cell || (e.button !== 0 && e.button !== 2)) return;
  e.preventDefault();
  const track = trackOf(cell);
  const current = track.steps[Number(cell.dataset.step)];
  let value;
  if (e.button === 2) value = 0;
  else if (e.shiftKey) value = current >= 0.9 ? 0 : VELOCITY.accent;
  else if (e.altKey) value = current > 0 && current < 0.6 ? 0 : VELOCITY.ghost;
  else value = current > 0 ? 0 : VELOCITY.normal;
  paint = { value, stroke: `${Date.now()}-${Math.random().toString(36).slice(2)}`, visited: new Set() };
  paintCell(cell);
});

grid.addEventListener('pointermove', (e) => {
  if (!paint) return;
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
  if (cell && grid.contains(cell)) paintCell(cell);
});

for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => (paint = null));
grid.addEventListener('contextmenu', (e) => e.preventDefault());

function paintCell(cell) {
  const track = trackOf(cell);
  const step = Number(cell.dataset.step);
  const key = `${track.id}:${step}`;
  if (paint.visited.has(key)) return;
  paint.visited.add(key);
  if (track.steps[step] === paint.value) return;
  act('setSteps', { track: track.id, steps: [{ step, velocity: paint.value }] }, paint.stroke);
  if (paint.value > 0 && !engine.running) audition(track, paint.value);
}

grid.addEventListener('click', (e) => {
  const button = e.target.closest('.mute-led, .solo-btn, .rm');
  if (!button) return;
  const track = trackOf(button);
  if (button.matches('.mute-led')) act('setTrack', { track: track.id, mute: !track.mute });
  else if (button.matches('.solo-btn')) act('setTrack', { track: track.id, solo: !track.solo });
  else act('removeTrack', { track: track.id });
});

// --- transport ---------------------------------------------------------------

// Don't overwrite a control the user is in the middle of changing.
function touch(key) {
  touchedAt.set(key, Date.now());
}
function recentlyTouched(key) {
  return Date.now() - (touchedAt.get(key) ?? 0) < 800;
}
function setControl(id, value) {
  const input = $(id);
  const typing = document.activeElement === input && input.type === 'number';
  if (!typing && !recentlyTouched(id)) input.value = value;
}

// LCD number fields: drag up or down to change them like a hardware display, or click to type.
function dragNumber(input, pxPerUnit, onDrag) {
  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || document.activeElement === input) return;
    e.preventDefault();
    input.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = Number(input.value);
    let dragged = false;
    const move = (ev) => {
      if (!dragged && Math.abs(startY - ev.clientY) < 3) return;
      dragged = true;
      const value = Math.min(Number(input.max), Math.max(Number(input.min), start + Math.round((startY - ev.clientY) / pxPerUnit)));
      if (String(value) === input.value) return;
      input.value = value;
      touch(input.id);
      onDrag(value);
    };
    const end = () => {
      input.removeEventListener('pointermove', move);
      input.removeEventListener('pointerup', end);
      input.removeEventListener('pointercancel', end);
      if (!dragged) {
        input.focus();
        input.select();
      }
    };
    input.addEventListener('pointermove', move);
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
}

const swing = createKnob({
  min: 50,
  max: 75,
  step: 1,
  value: 50,
  defaultValue: 50,
  label: 'Swing',
  format: (v) => `${v}%`,
  onInput: (v) => {
    touch('swing');
    $('swing-out').value = `${v}%`;
    act('setTransport', { swing: v }, 'swing');
  },
});
$('swing-control').prepend(swing.el);

function renderTransport() {
  setControl('bpm', state.bpm);
  setControl('length', state.length);
  setControl('spb', state.stepsPerBeat);
  if (!recentlyTouched('swing')) {
    swing.set(state.swing);
    $('swing-out').value = `${state.swing}%`;
  }
  const swingable = state.stepsPerBeat % 2 === 0;
  swing.setDisabled(!swingable);
  $('swing-control').title = swingable ? '50% is straight, 66% is a triplet shuffle' : 'Swing needs an even grid';
  $('undo').disabled = !meta.canUndo;
  $('redo').disabled = !meta.canRedo;
  if (!engine.running) $('position').value = '–.–';
}

const togglePlay = () => state && act('setPlaying', { playing: !state.playing });

$('play').addEventListener('click', togglePlay);
$('stop').addEventListener('click', () => act('setPlaying', { playing: false }));
dragNumber($('bpm'), 3, (bpm) => act('setTransport', { bpm }, 'bpm'));
dragNumber($('length'), 8, (length) => act('setTransport', { length }, 'length'));
$('bpm').addEventListener('change', (e) => e.target.value && act('setTransport', { bpm: Number(e.target.value) }));
$('length').addEventListener('change', (e) => e.target.value && act('setTransport', { length: Number(e.target.value) }));
$('spb').addEventListener('change', (e) => {
  touch('spb');
  act('setTransport', { stepsPerBeat: Number(e.target.value) });
});
$('undo').addEventListener('click', () => act('undo'));
$('redo').addEventListener('click', () => act('redo'));
$('clear').addEventListener('click', () => act('clearTracks'));
$('add-track').addEventListener('change', (e) => {
  if (e.target.value) act('addTrack', { instrument: e.target.value });
  e.target.value = '';
});
$('note-close').addEventListener('click', () => act('setNote', { body: '' }));

addEventListener('pointerdown', unlockAudio, true);
addEventListener('keydown', (e) => {
  unlockAudio();
  const typing = e.target.matches('input[type="number"], input[type="text"], textarea');
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space' && !typing && !mod) {
    e.preventDefault();
    togglePlay();
  } else if (mod && !typing && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    act(e.shiftKey ? 'redo' : 'undo');
  } else if (mod && !typing && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    act('redo');
  }
});

// --- browser (loop library) --------------------------------------------------

const LOOP_TYPE = 'application/x-beatlab-loop';
const OPEN_FOLDERS_KEY = 'beatlab.browser.open';
let library = [];
let selectedLoop = null;
let openFolders = null;

const findLoop = (id) => library.flatMap((f) => f.loops).find((l) => l.id === id) ?? null;

function saveOpenFolders() {
  try {
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders]));
  } catch {
    // Not persisting which folders are open is fine.
  }
}

async function loadLibrary() {
  try {
    library = await (await fetch('/api/library')).json();
  } catch {
    toast('Could not load the loop library.');
    return;
  }
  if (!openFolders) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY));
    } catch {}
    openFolders = new Set(saved ?? [state?.loop?.id.split('/')[0] ?? library[0]?.name].filter(Boolean));
  }
  selectedLoop = findLoop(selectedLoop?.id ?? state?.loop?.id);
  renderLibrary();
}

function renderLibrary() {
  const tree = $('library');
  if (library.length === 0) {
    tree.replaceChildren(el('li', 'tree-row muted', 'No loops yet. Add some to the library folder.'));
    return renderLibraryState();
  }
  tree.replaceChildren(
    ...library.map((folder) => {
      const item = el('li', 'folder');
      item.dataset.folder = folder.name;
      item.setAttribute('role', 'treeitem');
      const row = el('button', 'tree-row');
      row.append(el('span', 'chevron'), el('span', 'folder-icon'), el('span', 'folder-name', folder.name), el('span', 'tree-count', String(folder.loops.length)));
      const group = el('ul');
      group.setAttribute('role', 'group');
      for (const loop of folder.loops) {
        const li = el('li', 'tree-row loop-row');
        li.dataset.id = loop.id;
        li.setAttribute('role', 'treeitem');
        li.tabIndex = 0;
        li.draggable = true;
        li.title = `${loop.name}: double-click or drag onto the sequencer to load`;
        li.append(el('span', 'loop-icon'), el('span', 'loop-label', loop.name), el('span', 'loop-bpm', String(loop.bpm)));
        group.append(li);
      }
      item.append(row, group);
      return item;
    }),
  );
  renderLibraryState();
}

function renderLibraryState() {
  for (const folder of $('library').querySelectorAll('.folder')) {
    const open = !!openFolders?.has(folder.dataset.folder);
    folder.classList.toggle('open', open);
    folder.setAttribute('aria-expanded', open);
  }
  for (const row of $('library').querySelectorAll('.loop-row')) {
    row.classList.toggle('selected', row.dataset.id === selectedLoop?.id);
    row.classList.toggle('current', row.dataset.id === state?.loop?.id);
  }
  renderLoopDetails();
}

function renderLoopDetails() {
  const loop = selectedLoop;
  $('loop-details').hidden = !loop;
  if (!loop) return;
  $('loop-name').textContent = loop.name;
  $('loop-meta').textContent = `${loop.folder} · ${loop.bpm} BPM${loop.swing > 50 ? ` · swing ${loop.swing}%` : ''} · ${loop.length} steps`;
  $('loop-description').textContent = loop.description;
  const preview = $('loop-preview');
  if (preview.dataset.id === loop.id) return;
  preview.dataset.id = loop.id;
  preview.replaceChildren(
    ...loop.tracks.map((track) => {
      const row = el('div', 'preview-row');
      row.style.setProperty('--c', instruments[track.instrument].color);
      track.steps.forEach((v, i) => {
        const dot = el('i', v > 0 ? 'on' : '');
        if (i % loop.stepsPerBeat === 0) dot.classList.add('beat-start');
        dot.style.setProperty('--v', v);
        row.append(dot);
      });
      return row;
    }),
  );
}

// Shows which loop the pattern came from, and reveals it in the browser when it changes
// (also when Claude loads one).
function renderLoopIndicator(previous) {
  const { loop } = state;
  $('seq-loop').hidden = !loop;
  $('seq-loop').textContent = loop?.name ?? '';
  $('seq-loop').title = loop ? `Started from ${loop.id}` : '';
  if (loop && library.length && loop.id !== previous?.loop?.id) {
    openFolders.add(loop.id.split('/')[0]);
    saveOpenFolders();
    selectedLoop = findLoop(loop.id) ?? selectedLoop;
    renderLibraryState();
    $('library').querySelector(`[data-id="${CSS.escape(loop.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  } else {
    renderLibraryState();
  }
}

function loadLoop(id) {
  const loop = findLoop(id);
  act('loadLoop', { id });
  if (loop) toast(`Loaded “${loop.name}”. Ctrl+Z to go back.`, 'info');
}

$('library').addEventListener('click', (e) => {
  const folderRow = e.target.closest('.folder > .tree-row');
  if (folderRow) {
    const name = folderRow.parentElement.dataset.folder;
    if (!openFolders.delete(name)) openFolders.add(name);
    saveOpenFolders();
    return renderLibraryState();
  }
  const loopRow = e.target.closest('.loop-row');
  if (loopRow) {
    selectedLoop = findLoop(loopRow.dataset.id);
    renderLibraryState();
  }
});
$('library').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.loop-row');
  if (row) loadLoop(row.dataset.id);
});
$('library').addEventListener('keydown', (e) => {
  const row = e.target.closest('.loop-row');
  if (row && e.key === 'Enter') loadLoop(row.dataset.id);
});
$('loop-load').addEventListener('click', () => selectedLoop && loadLoop(selectedLoop.id));
$('library-refresh').addEventListener('click', loadLibrary);

// Drag a loop from the browser onto the sequencer window to load it.
const sequencerWindow = $('win-sequencer');
$('library').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.loop-row');
  if (!row) return;
  e.dataTransfer.setData(LOOP_TYPE, row.dataset.id);
  e.dataTransfer.effectAllowed = 'copy';
});
sequencerWindow.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(LOOP_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  sequencerWindow.classList.add('drop-target');
});
sequencerWindow.addEventListener('dragleave', (e) => {
  if (!sequencerWindow.contains(e.relatedTarget)) sequencerWindow.classList.remove('drop-target');
});
sequencerWindow.addEventListener('drop', (e) => {
  sequencerWindow.classList.remove('drop-target');
  const id = e.dataTransfer.getData(LOOP_TYPE);
  if (!id) return;
  e.preventDefault();
  loadLoop(id);
});
addEventListener('dragend', () => sequencerWindow.classList.remove('drop-target'));

// --- Claude window -----------------------------------------------------------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// A small, safe subset of Markdown for Claude's notes: paragraphs, "- " lists, **bold**, *italic*, `code`.
function renderMarkdown(source) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const bullet = /^\s*[-*•]\s+/;
  return source
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => bullet.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(bullet, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

function renderNote(previous) {
  const { note } = state;
  const card = $('note-card');
  card.hidden = !note;
  if (!note) return;
  $('note-title').textContent = note.title || 'Note';
  $('note-body').innerHTML = renderMarkdown(note.body);
  if (previous && JSON.stringify(previous.note) !== JSON.stringify(note)) {
    flash(card, 'fresh');
    // If the Claude window is collapsed, make its title bar ask for attention.
    if ($('win-claude').classList.contains('collapsed')) flash($('win-claude').querySelector('.titlebar'), 'attention');
  }
}

function ago(timestamp) {
  const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function renderActivity() {
  const list = $('activity');
  if (!activity.length) {
    list.replaceChildren(el('li', 'empty', 'Nothing yet. Edit the grid or ask Claude.'));
    return;
  }
  list.replaceChildren(
    ...activity.slice(0, 30).map((a) => {
      const item = el('li');
      const claude = a.source === 'claude';
      item.append(el('span', claude ? 'who claude' : 'who', claude ? 'Claude' : 'You'), el('span', 'what', a.text), el('span', 'when', ago(a.at)));
      return item;
    }),
  );
}

function renderClaudeStatus() {
  const pill = $('claude-status');
  const seen = meta.claudeLastSeen;
  pill.classList.toggle('live', !!seen && Date.now() - seen < 5 * 60_000);
  pill.textContent = seen ? `active ${ago(seen)}` : 'not connected yet';
}

function toast(message, kind = 'error') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3500);
}

// --- start -------------------------------------------------------------------

for (const [value, label] of Object.entries(SUBDIVISIONS)) $('spb').append(new Option(`${value} · ${label}`, value));
for (const inst of INSTRUMENTS) $('add-track').append(new Option(inst.name, inst.id));

// Claude Code can trip over "localhost" resolving to IPv6, so point it at 127.0.0.1.
const mcpOrigin = location.hostname === 'localhost' ? `${location.protocol}//127.0.0.1:${location.port}` : location.origin;
$('mcp-cmd').textContent = `claude mcp add --scope user --transport http beat-lab ${mcpOrigin}/mcp`;
$('copy-cmd').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('mcp-cmd').textContent);
    $('copy-cmd').textContent = 'Copied';
    setTimeout(() => ($('copy-cmd').textContent = 'Copy'), 1500);
  } catch {
    getSelection().selectAllChildren($('mcp-cmd'));
  }
});

initWindows($('workspace'), {
  browser: () => ({ x: 16, y: 16 }),
  sequencer: () => ({ x: 260, y: 16 }),
  claude: (workspace, win) => ({ x: workspace.clientWidth - win.offsetWidth - 16, y: 16 }),
});

setInterval(() => {
  renderActivity();
  renderClaudeStatus();
}, 15_000);

renderAudioChip();
connect();
loadLibrary();
