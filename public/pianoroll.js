// Piano roll for synth tracks. Notes live on the server like everything else; this module
// shows the selected synth track and turns mouse gestures into note actions. The gestures
// match the drum grid: left-click adds a note and drags it, dragging a note's right edge
// resizes it, right-click or right-drag deletes, Shift makes an accent and Alt a soft note.

import { SYNTHS, PITCH_RANGE, noteName } from '/shared/synths.js';
import { createKnob } from './knob.js';

const ROW = 14; // px per pitch
const COL = 24; // px per step
const RULER = 22;
const [LOW, HIGH] = PITCH_RANGE;
const VELOCITY = { normal: 0.8, accent: 1, soft: 0.45 };
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const presets = Object.fromEntries(SYNTHS.map((s) => [s.id, s]));

const isBlack = (pitch) => BLACK_KEYS.has(pitch % 12);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const newNoteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Row shading (black-key rows darker), row and step lines, and stronger beat and octave lines.
function laneBackground(stepsPerBeat) {
  const bands = [];
  for (let k = 0; k < 12; k++) {
    bands.push(`${isBlack(HIGH - k) ? 'var(--roll-black)' : 'var(--roll-white)'} ${k * ROW}px ${(k + 1) * ROW}px`);
  }
  const beat = COL * stepsPerBeat;
  return [
    `repeating-linear-gradient(to right, transparent 0 ${beat - 1}px, var(--roll-beat) ${beat - 1}px ${beat}px)`,
    `repeating-linear-gradient(to right, transparent 0 ${COL - 1}px, var(--roll-line) ${COL - 1}px ${COL}px)`,
    `repeating-linear-gradient(to bottom, transparent 0 ${ROW - 1}px, var(--roll-octave) ${ROW - 1}px ${ROW}px, transparent ${ROW}px ${12 * ROW}px)`,
    `repeating-linear-gradient(to bottom, transparent 0 ${ROW - 1}px, var(--roll-line) ${ROW - 1}px ${ROW}px)`,
    `repeating-linear-gradient(to bottom, ${bands.join(', ')})`,
  ].join(', ');
}

export function createPianoRoll({ engine, act, getState }) {
  const $ = (id) => document.getElementById(id);
  const scroll = $('roll-scroll');
  const lanes = $('roll-lanes');
  const ruler = $('roll-ruler');
  const keys = $('roll-keys');
  const tabs = $('synth-tabs');
  const presetSelect = $('synth-preset');
  const mute = $('synth-mute');
  const solo = $('synth-solo');
  const clearButton = $('synth-clear');
  const playhead = el('div', 'pr-playhead');

  let selectedId = null;
  let scrolledFor = null;
  let gridSignature = '';
  let lastLength = 2;
  let gesture = null;
  let selectNewTrack = false;

  const selected = () => getState()?.synths.find((s) => s.id === selectedId) ?? null;

  const volume = createKnob({
    min: 0,
    max: 1,
    value: 0.7,
    defaultValue: 0.7,
    size: 'sm',
    label: 'Synth volume',
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      const synth = selected();
      if (synth) act('setTrack', { track: synth.id, volume: v }, `vol:${synth.id}`);
    },
  });
  $('synth-volume').replaceWith(volume.el);

  $('roll').style.cssText = `--row:${ROW}px; --col:${COL}px; --ruler:${RULER}px`;
  for (const preset of SYNTHS) {
    presetSelect.append(new Option(preset.name, preset.id));
    $('add-synth').append(new Option(preset.name, preset.id));
  }
  for (let pitch = HIGH; pitch >= LOW; pitch--) {
    const key = el('div', `key ${isBlack(pitch) ? 'black' : 'white'}`, pitch % 12 === 0 ? noteName(pitch) : '');
    key.dataset.pitch = pitch;
    key.title = noteName(pitch);
    keys.append(key);
  }
  lanes.style.height = `${(HIGH - LOW + 1) * ROW}px`;

  function preview(pitch, velocity = VELOCITY.normal) {
    const synth = selected();
    if (synth) engine.playNote(synth.preset, pitch, undefined, 0.35, velocity * synth.volume);
  }

  // --- rendering -----------------------------------------------------------------

  function render(previous, source) {
    const state = getState();
    if (!state) return;
    if (selectNewTrack && previous && state.synths.length > previous.synths.length) {
      selectedId = state.synths.at(-1).id;
      selectNewTrack = false;
    }
    // Follow Claude to the track it just wrote.
    if (source === 'claude' && previous) {
      const changed = state.synths.filter(
        (s) => JSON.stringify(s.notes) !== JSON.stringify(previous.synths.find((p) => p.id === s.id)?.notes),
      );
      if (changed.length && !changed.some((s) => s.id === selectedId)) selectedId = changed[0].id;
    }
    if (!state.synths.some((s) => s.id === selectedId)) selectedId = state.synths[0]?.id ?? null;

    renderGrid(state);
    renderTabs(state);
    renderControls();
    renderNotes(state, previous, source);
    if (scrolledFor !== selectedId) scrollToNotes();
    const synth = selected();
    $('roll-meta').textContent = synth ? `${synth.name} · ${synth.notes.length} note${synth.notes.length === 1 ? '' : 's'}` : '';
  }

  function renderGrid(state) {
    const signature = `${state.length}/${state.stepsPerBeat}`;
    if (signature === gridSignature) return;
    gridSignature = signature;
    const width = `${state.length * COL}px`;
    lanes.style.width = width;
    lanes.style.backgroundImage = laneBackground(state.stepsPerBeat);
    ruler.style.width = width;
    ruler.replaceChildren(
      ...Array.from({ length: state.length }, (_, i) => {
        const downbeat = i % state.stepsPerBeat === 0;
        const tick = el('span', downbeat ? 'beat' : '', downbeat ? String(i / state.stepsPerBeat + 1) : '');
        tick.dataset.step = i;
        return tick;
      }),
    );
  }

  function renderTabs(state) {
    if (state.synths.length === 0) {
      tabs.replaceChildren(el('span', 'muted', 'No synth tracks yet'));
      return;
    }
    tabs.replaceChildren(
      ...state.synths.map((synth) => {
        const active = synth.id === selectedId;
        const tab = el('button', `synth-tab${active ? ' active' : ''}${synth.mute ? ' muted' : ''}`);
        tab.dataset.id = synth.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', active);
        tab.style.setProperty('--c', presets[synth.preset].color);
        const remove = el('span', 'tab-rm', '×');
        remove.title = `Remove ${synth.name}`;
        tab.append(el('span', 'tab-dot'), el('span', 'tab-name', synth.name), remove);
        return tab;
      }),
    );
  }

  function renderControls() {
    const synth = selected();
    for (const control of [mute, solo, presetSelect, clearButton]) control.disabled = !synth;
    volume.setDisabled(!synth);
    if (!synth) return;
    mute.classList.toggle('muted', synth.mute);
    mute.title = synth.mute ? 'Unmute' : 'Mute';
    solo.classList.toggle('on', synth.solo);
    presetSelect.value = synth.preset;
    volume.set(synth.volume);
    volume.el.style.setProperty('--arc', presets[synth.preset].color);
  }

  function noteElement(note, color, className) {
    const node = el('div', className, note.length * COL >= 34 ? noteName(note.pitch) : '');
    node.style.cssText =
      `left:${note.start * COL}px; top:${(HIGH - note.pitch) * ROW}px; width:${note.length * COL - 1}px; ` +
      `--c:${color}; --v:${note.velocity}`;
    return node;
  }

  function renderNotes(state, previous, source) {
    const synth = selected();
    const items = [playhead];
    // Other synth tracks show faintly behind the selected one, to line parts up.
    for (const other of state.synths) {
      if (other === synth) continue;
      for (const note of other.notes) items.push(noteElement(note, presets[other.preset].color, 'pr-note ghost'));
    }
    if (synth) {
      const before = new Map((previous?.synths.find((s) => s.id === synth.id)?.notes ?? []).map((n) => [n.id, n]));
      for (const note of synth.notes) {
        const node = noteElement(note, presets[synth.preset].color, 'pr-note');
        node.dataset.id = note.id;
        node.classList.toggle('accent', note.velocity >= 0.9);
        node.append(el('span', 'pr-handle'));
        const old = before.get(note.id);
        const moved = !old || old.pitch !== note.pitch || old.start !== note.start || old.length !== note.length;
        if (source === 'claude' && previous && moved) node.classList.add('flash');
        items.push(node);
      }
    } else {
      items.push(el('div', 'roll-empty', 'Add a synth track to start writing notes.'));
    }
    lanes.replaceChildren(...items);
  }

  function scrollToNotes() {
    const synth = selected();
    if (!synth || scroll.clientHeight === 0) return;
    scrolledFor = selectedId;
    const pitches = synth.notes.map((n) => n.pitch);
    const center = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : synth.preset === 'bass' ? 40 : 62;
    scroll.scrollTop = (HIGH - center) * ROW + RULER - scroll.clientHeight / 2;
  }
  // A collapsed window has no size yet; scroll once it opens.
  new ResizeObserver(() => scrolledFor !== selectedId && scrollToNotes()).observe(scroll);

  function setPlayhead(step) {
    playhead.classList.toggle('on', step >= 0);
    if (step >= 0) playhead.style.left = `${step * COL}px`;
    for (const tick of ruler.querySelectorAll('.now')) tick.classList.remove('now');
    if (step >= 0) ruler.querySelector(`[data-step="${step}"]`)?.classList.add('now');
  }

  // --- editing -------------------------------------------------------------------

  function cellAt(e) {
    const r = lanes.getBoundingClientRect();
    return {
      step: clamp(Math.floor((e.clientX - r.left) / COL), 0, getState().length - 1),
      pitch: clamp(HIGH - Math.floor((e.clientY - r.top) / ROW), LOW, HIGH),
    };
  }

  // Apply a change locally right away so dragging feels immediate; the server confirms it.
  function update(note, changes) {
    Object.assign(note, changes);
    const local = selected()?.notes.find((n) => n.id === note.id);
    if (local) Object.assign(local, changes);
    act('updateNote', { synth: gesture.synthId, id: note.id, ...changes }, gesture.stroke);
    renderNotes(getState());
  }

  function erase(note) {
    if (gesture.erased.has(note.id)) return;
    gesture.erased.add(note.id);
    const synth = selected();
    if (synth) synth.notes = synth.notes.filter((n) => n.id !== note.id);
    act('deleteNotes', { synth: gesture.synthId, ids: [note.id] }, gesture.stroke);
    renderNotes(getState());
  }

  const noteUnder = (target) => {
    const node = target?.closest?.('.pr-note:not(.ghost)');
    return node ? (selected()?.notes.find((n) => n.id === node.dataset.id) ?? null) : null;
  };

  lanes.addEventListener('contextmenu', (e) => e.preventDefault());

  lanes.addEventListener('pointerdown', (e) => {
    const synth = selected();
    if (!synth || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    lanes.setPointerCapture(e.pointerId);
    const note = noteUnder(e.target);
    gesture = { synthId: synth.id, stroke: `${Date.now()}-${Math.random().toString(36).slice(2)}`, erased: new Set() };

    if (e.button === 2) {
      gesture.kind = 'erase';
      if (note) erase(note);
      return;
    }
    if (note && (e.shiftKey || e.altKey)) {
      const target = e.shiftKey ? VELOCITY.accent : VELOCITY.soft;
      update({ ...note }, { velocity: note.velocity === target ? VELOCITY.normal : target });
      gesture = null;
      return;
    }
    const at = cellAt(e);
    if (note && e.target.closest('.pr-handle')) {
      Object.assign(gesture, { kind: 'resize', note: { ...note } });
    } else if (note) {
      Object.assign(gesture, { kind: 'move', note: { ...note }, grab: at.step - note.start });
      preview(note.pitch, note.velocity);
    } else {
      const velocity = e.shiftKey ? VELOCITY.accent : e.altKey ? VELOCITY.soft : VELOCITY.normal;
      const created = { id: newNoteId(), pitch: at.pitch, start: at.step, length: Math.min(lastLength, getState().length - at.step), velocity };
      synth.notes.push({ ...created });
      act('addNote', { synth: synth.id, note: created }, gesture.stroke);
      preview(created.pitch, velocity);
      Object.assign(gesture, { kind: 'move', note: created, grab: 0 });
      renderNotes(getState());
    }
  });

  lanes.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    if (gesture.kind === 'erase') {
      const note = noteUnder(document.elementFromPoint(e.clientX, e.clientY));
      if (note) erase(note);
      return;
    }
    const { note } = gesture;
    const at = cellAt(e);
    if (gesture.kind === 'move') {
      const start = clamp(at.step - gesture.grab, 0, getState().length - note.length);
      if (start === note.start && at.pitch === note.pitch) return;
      if (at.pitch !== note.pitch) preview(at.pitch, note.velocity);
      update(note, { start, pitch: at.pitch });
    } else {
      const r = lanes.getBoundingClientRect();
      const length = clamp(Math.round((e.clientX - r.left) / COL) - note.start, 1, getState().length - note.start);
      if (length !== note.length) update(note, { length });
    }
  });

  const endGesture = () => {
    if (gesture?.note) lastLength = gesture.note.length;
    gesture = null;
  };
  lanes.addEventListener('pointerup', endGesture);
  lanes.addEventListener('pointercancel', endGesture);

  keys.addEventListener('pointerdown', (e) => {
    const key = e.target.closest('.key');
    if (!key) return;
    preview(Number(key.dataset.pitch));
    key.classList.add('pressed');
    setTimeout(() => key.classList.remove('pressed'), 180);
  });

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.synth-tab');
    if (!tab) return;
    if (e.target.closest('.tab-rm')) return act('removeTrack', { track: tab.dataset.id });
    selectedId = tab.dataset.id;
    render();
  });

  $('add-synth').addEventListener('change', (e) => {
    if (e.target.value) {
      selectNewTrack = true;
      act('addTrack', { instrument: e.target.value });
    }
    e.target.value = '';
  });
  mute.addEventListener('click', () => selected() && act('setTrack', { track: selectedId, mute: !selected().mute }));
  solo.addEventListener('click', () => selected() && act('setTrack', { track: selectedId, solo: !selected().solo }));
  presetSelect.addEventListener('change', () => selected() && act('setTrack', { track: selectedId, instrument: presetSelect.value }));
  clearButton.addEventListener('click', () => selected() && act('clearTracks', { tracks: [selectedId] }));

  return { render, setPlayhead };
}
