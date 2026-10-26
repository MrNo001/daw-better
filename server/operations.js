// Every edit to the sequencer goes through these functions, whether it comes from the
// browser or from Claude. Each one mutates `state` in place and returns a short
// description for the activity log. Step indexes are 0-based here.

import { INSTRUMENTS, DEFAULT_KIT, normalizeName, resolveInstrument } from '../shared/instruments.js';
import { parseSteps } from './notation.js';

export const LIMITS = { bpm: [30, 300], swing: [50, 75], length: [1, 64], stepsPerBeat: [1, 8], tracks: 16 };

const clamp = (value, [lo, hi]) => Math.min(hi, Math.max(lo, value));

function toNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

function resize(steps, length) {
  return Array.from({ length }, (_, i) => steps[i] ?? 0);
}

function makeTrack(state, instrumentId, name) {
  const inst = INSTRUMENTS.find((i) => i.id === instrumentId);
  const base = (name && normalizeName(name).replace(/[^a-z0-9_]/g, '')) || inst.id;
  let id = base;
  for (let n = 2; state.tracks.some((t) => t.id === id); n++) id = `${base}_${n}`;
  return {
    id,
    name: name?.trim() || inst.name,
    instrument: inst.id,
    volume: 0.8,
    mute: false,
    solo: false,
    steps: new Array(state.length).fill(0),
  };
}

const trackList = (state) => state.tracks.map((t) => t.id).join(', ') || '(none)';
const instrumentList = () => INSTRUMENTS.map((i) => i.id).join(', ');

export function findTrack(state, ref) {
  const key = normalizeName(ref);
  const direct = state.tracks.find((t) => t.id === key || normalizeName(t.name) === key);
  if (direct) return direct;
  const inst = resolveInstrument(ref);
  return inst ? (state.tracks.find((t) => t.instrument === inst.id) ?? null) : null;
}

function requireTrack(state, ref) {
  const track = findTrack(state, ref);
  if (!track) throw new Error(`There is no track "${ref}". Tracks: ${trackList(state)}.`);
  return track;
}

// Writing hits to an instrument that has no track yet adds the track.
function findOrAddTrack(state, ref) {
  const track = findTrack(state, ref);
  if (track) return track;
  const inst = resolveInstrument(ref);
  if (!inst) {
    throw new Error(`There is no track or instrument "${ref}". Tracks: ${trackList(state)}. Instruments: ${instrumentList()}.`);
  }
  return pushTrack(state, inst.id);
}

function pushTrack(state, instrumentId, name) {
  if (state.tracks.length >= LIMITS.tracks) throw new Error(`The sequencer holds at most ${LIMITS.tracks} tracks.`);
  const track = makeTrack(state, instrumentId, name);
  state.tracks.push(track);
  return track;
}

export function defaultState() {
  const state = { bpm: 100, swing: 50, length: 16, stepsPerBeat: 4, playing: false, tracks: [], note: null, loop: null };
  for (const id of DEFAULT_KIT) pushTrack(state, id);
  setPattern(state, {
    tracks: { kick: 'x... .... x.x. ....', snare: '.... x... .... x...', closed_hat: 'x.' },
  });
  state.note = {
    title: 'Welcome to daw-better',
    body:
      'This is a basic rock beat: kick on beats **1** and **3**, snare on the **backbeat** (2 and 4), ' +
      'and a closed hi-hat on every 8th note.\n\n' +
      'Press **Space** to play. Click cells to edit, pick a genre loop in the **Browser**, ' +
      'or ask Claude to write a groove, explain one, or quiz you.',
    highlights: [{ track: 'snare', steps: [4, 12] }],
  };
  return state;
}

// Rebuild a state loaded from disk, keeping only valid fields.
export function sanitize(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;
  const num = (v, limits, fallback) => (Number.isFinite(v) ? Math.round(clamp(v, limits)) : fallback);
  state.bpm = num(raw.bpm, LIMITS.bpm, state.bpm);
  state.swing = num(raw.swing, LIMITS.swing, state.swing);
  state.length = num(raw.length, LIMITS.length, state.length);
  state.stepsPerBeat = num(raw.stepsPerBeat, LIMITS.stepsPerBeat, state.stepsPerBeat);
  if (Array.isArray(raw.tracks)) {
    state.tracks = raw.tracks
      .filter((t) => t && INSTRUMENTS.some((i) => i.id === t.instrument) && typeof t.id === 'string')
      .slice(0, LIMITS.tracks)
      .map((t) => ({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : t.id,
        instrument: t.instrument,
        volume: Number.isFinite(t.volume) ? clamp(t.volume, [0, 1]) : 0.8,
        mute: !!t.mute,
        solo: !!t.solo,
        steps: resize(Array.isArray(t.steps) ? t.steps.map((v) => clamp(Number(v) || 0, [0, 1])) : [], state.length),
      }));
  }
  const note = raw.note;
  state.note =
    note && typeof note.body === 'string'
      ? {
          title: typeof note.title === 'string' ? note.title : '',
          body: note.body,
          highlights: (Array.isArray(note.highlights) ? note.highlights : [])
            .filter((h) => typeof h?.track === 'string' && Array.isArray(h.steps))
            .map((h) => ({ track: h.track, steps: h.steps.filter(Number.isInteger) })),
        }
      : null;
  state.loop = typeof raw.loop?.id === 'string' ? { id: raw.loop.id, name: String(raw.loop.name ?? raw.loop.id) } : null;
  return state;
}

// Replace the whole pattern with a loop from the library (see library.js).
export function loadLoop(state, loop) {
  state.bpm = loop.bpm;
  state.swing = loop.swing;
  state.stepsPerBeat = loop.stepsPerBeat;
  state.length = loop.length;
  state.tracks = [];
  for (const t of loop.tracks) {
    const track = pushTrack(state, t.instrument, t.name);
    track.volume = t.volume;
    track.steps = [...t.steps];
  }
  state.loop = { id: loop.id, name: loop.name };
  return `loaded ${loop.folder} / ${loop.name}`;
}

export function setPattern(state, { tracks, clearOthers = false }) {
  const entries = Object.entries(tracks ?? {});
  if (entries.length === 0) throw new Error('Give at least one track.');
  const written = [];
  for (const [ref, text] of entries) {
    const track = findOrAddTrack(state, ref);
    track.steps = parseSteps(text, state.length);
    written.push(track);
  }
  if (clearOthers) {
    for (const t of state.tracks) if (!written.includes(t)) t.steps.fill(0);
  }
  return `wrote ${written.map((t) => t.name).join(', ')}${clearOthers ? ' and cleared the rest' : ''}`;
}

export function setSteps(state, { track: ref, steps }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('Give at least one step.');
  const track = findOrAddTrack(state, ref);
  for (const { step, velocity } of steps) {
    if (!Number.isInteger(step) || step < 0 || step >= state.length) {
      throw new Error(`Step ${step + 1} is out of range; the pattern has steps 1-${state.length}.`);
    }
    track.steps[step] = clamp(toNumber(velocity, 'velocity'), [0, 1]);
  }
  if (steps.length === 1) return `${track.name} step ${steps[0].step + 1} ${steps[0].velocity > 0 ? 'on' : 'off'}`;
  return `edited ${steps.length} steps on ${track.name}`;
}

export function setTransport(state, { bpm, swing, length, stepsPerBeat }) {
  const changes = [];
  if (bpm !== undefined) {
    state.bpm = Math.round(clamp(toNumber(bpm, 'bpm'), LIMITS.bpm));
    changes.push(`tempo ${state.bpm} BPM`);
  }
  if (swing !== undefined) {
    state.swing = Math.round(clamp(toNumber(swing, 'swing'), LIMITS.swing));
    changes.push(`swing ${state.swing}%`);
  }
  if (stepsPerBeat !== undefined) {
    state.stepsPerBeat = Math.round(clamp(toNumber(stepsPerBeat, 'steps per beat'), LIMITS.stepsPerBeat));
    changes.push(`${state.stepsPerBeat} steps per beat`);
  }
  if (length !== undefined) {
    state.length = Math.round(clamp(toNumber(length, 'length'), LIMITS.length));
    for (const t of state.tracks) t.steps = resize(t.steps, state.length);
    changes.push(`length ${state.length} steps`);
  }
  if (changes.length === 0) throw new Error('Nothing to change.');
  return changes.join(', ');
}

export function setPlaying(state, { playing }) {
  state.playing = !!playing;
  return state.playing ? 'play' : 'stop';
}

export function setTrack(state, { track: ref, volume, mute, solo, name, instrument }) {
  const track = requireTrack(state, ref);
  const changes = [];
  if (volume !== undefined) {
    track.volume = clamp(toNumber(volume, 'volume'), [0, 1]);
    changes.push(`volume ${Math.round(track.volume * 100)}%`);
  }
  if (mute !== undefined) {
    track.mute = !!mute;
    changes.push(track.mute ? 'muted' : 'unmuted');
  }
  if (solo !== undefined) {
    track.solo = !!solo;
    changes.push(track.solo ? 'solo on' : 'solo off');
  }
  if (instrument !== undefined) {
    const inst = resolveInstrument(instrument);
    if (!inst) throw new Error(`Unknown instrument "${instrument}". Instruments: ${instrumentList()}.`);
    track.instrument = inst.id;
    changes.push(`sound ${inst.name}`);
  }
  if (name !== undefined && String(name).trim()) {
    changes.push(`renamed from ${track.name}`);
    track.name = String(name).trim();
  }
  if (changes.length === 0) throw new Error('Nothing to change.');
  return `${track.name}: ${changes.join(', ')}`;
}

export function addTrack(state, { instrument, name }) {
  const inst = resolveInstrument(instrument);
  if (!inst) throw new Error(`Unknown instrument "${instrument}". Instruments: ${instrumentList()}.`);
  const track = pushTrack(state, inst.id, name);
  return `added ${track.name}`;
}

export function removeTrack(state, { track: ref }) {
  const track = requireTrack(state, ref);
  state.tracks.splice(state.tracks.indexOf(track), 1);
  return `removed ${track.name}`;
}

export function clearTracks(state, { tracks } = {}) {
  const targets = tracks?.length ? tracks.map((ref) => requireTrack(state, ref)) : state.tracks;
  for (const t of targets) t.steps.fill(0);
  return tracks?.length ? `cleared ${targets.map((t) => t.name).join(', ')}` : 'cleared every track';
}

export function setNote(state, { title, body, highlights }) {
  if (!body?.trim()) {
    state.note = null;
    return 'removed the note';
  }
  state.note = {
    title: title?.trim() ?? '',
    body: body.trim(),
    highlights: (highlights ?? []).map((h) => ({
      track: requireTrack(state, h.track).id,
      steps: h.steps.filter((s) => Number.isInteger(s) && s >= 0 && s < state.length),
    })),
  };
  return `note: ${state.note.title || state.note.body.slice(0, 48)}`;
}
