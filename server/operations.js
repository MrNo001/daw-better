// Every edit to the sequencer goes through these functions, whether it comes from the
// browser or from Claude. Each one mutates `state` in place and returns a short
// description for the activity log. Step indexes are 0-based here.
//
// There are two kinds of track: drum tracks (state.tracks) hold one velocity per step,
// and synth tracks (state.synths) hold notes for the piano roll. Both share the
// transport, so a note's start and length are measured in the same steps as the drums.

import { INSTRUMENTS, DEFAULT_KIT, normalizeName, resolveInstrument } from '../shared/instruments.js';
import { SYNTHS, PITCH_RANGE, noteName, parsePitch, resolveSynth } from '../shared/synths.js';
import { parseSteps } from './notation.js';

export const LIMITS = { bpm: [30, 300], swing: [50, 75], length: [1, 64], stepsPerBeat: [1, 8], tracks: 16, synths: 8 };

const clamp = (value, [lo, hi]) => Math.min(hi, Math.max(lo, value));

function toNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

function resize(steps, length) {
  return Array.from({ length }, (_, i) => steps[i] ?? 0);
}

// Drum and synth tracks share one id space, so any track can be referred to by id.
function uniqueId(state, name, fallback) {
  const base = (name && normalizeName(name).replace(/[^a-z0-9_]/g, '')) || fallback;
  const taken = new Set([...state.tracks, ...state.synths].map((t) => t.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

const trackList = (state) => [...state.tracks, ...state.synths].map((t) => t.id).join(', ') || '(none)';
const instrumentList = () => INSTRUMENTS.map((i) => i.id).join(', ');
const synthList = () => SYNTHS.map((s) => s.id).join(', ');

// --- drum tracks ---------------------------------------------------------------

export function findTrack(state, ref) {
  const key = normalizeName(ref);
  const direct = state.tracks.find((t) => t.id === key || normalizeName(t.name) === key);
  if (direct) return direct;
  const inst = resolveInstrument(ref);
  return inst ? (state.tracks.find((t) => t.instrument === inst.id) ?? null) : null;
}

function requireTrack(state, ref) {
  const track = findTrack(state, ref);
  if (!track) throw new Error(`There is no drum track "${ref}". Tracks: ${trackList(state)}.`);
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
  if (state.tracks.length >= LIMITS.tracks) throw new Error(`The sequencer holds at most ${LIMITS.tracks} drum tracks.`);
  const inst = INSTRUMENTS.find((i) => i.id === instrumentId);
  const track = {
    id: uniqueId(state, name, inst.id),
    name: name?.trim() || inst.name,
    instrument: inst.id,
    volume: 0.8,
    mute: false,
    solo: false,
    steps: new Array(state.length).fill(0),
  };
  state.tracks.push(track);
  return track;
}

// --- synth tracks --------------------------------------------------------------

export function findSynth(state, ref) {
  const key = normalizeName(ref);
  const direct = state.synths.find((s) => s.id === key || normalizeName(s.name) === key);
  if (direct) return direct;
  const preset = resolveSynth(ref);
  return preset ? (state.synths.find((s) => s.preset === preset.id) ?? null) : null;
}

function requireSynth(state, ref) {
  const synth = findSynth(state, ref);
  if (!synth) throw new Error(`There is no synth track "${ref}". Synth tracks: ${state.synths.map((s) => s.id).join(', ') || '(none)'}.`);
  return synth;
}

// Writing notes for a synth sound that has no track yet adds the track.
function findOrAddSynth(state, ref) {
  const synth = findSynth(state, ref);
  if (synth) return synth;
  const preset = resolveSynth(ref);
  if (!preset) throw new Error(`There is no synth track or sound "${ref}". Synth sounds: ${synthList()}.`);
  return pushSynth(state, preset.id);
}

function pushSynth(state, presetId, name) {
  if (state.synths.length >= LIMITS.synths) throw new Error(`There can be at most ${LIMITS.synths} synth tracks.`);
  const preset = SYNTHS.find((s) => s.id === presetId);
  const synth = {
    id: uniqueId(state, name, preset.id),
    name: name?.trim() || preset.name,
    preset: preset.id,
    volume: 0.7,
    mute: false,
    solo: false,
    notes: [],
  };
  state.synths.push(synth);
  return synth;
}

const newNoteId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function makeNote(state, { id, pitch, start, length = 1, velocity = 0.8 }) {
  const midi = parsePitch(pitch);
  if (midi === null || midi < PITCH_RANGE[0] || midi > PITCH_RANGE[1]) {
    throw new Error(`"${pitch}" isn't a note between C1 and C7. Use a name like "A2", "F#4" or "Bb3" (C4 is middle C).`);
  }
  if (!Number.isInteger(start) || start < 0 || start >= state.length) {
    throw new Error(`A note can't start on step ${start + 1}; the pattern has steps 1-${state.length}.`);
  }
  return {
    id: typeof id === 'string' && /^[\w-]{1,40}$/.test(id) ? id : newNoteId(),
    pitch: midi,
    start,
    length: Math.round(clamp(toNumber(length, 'length'), [1, state.length - start])),
    velocity: clamp(toNumber(velocity, 'velocity'), [0, 1]),
  };
}

function sortNotes(synth) {
  synth.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// After the loop gets shorter, drop notes that start past the end and shorten the rest.
function trimNotes(state) {
  for (const synth of state.synths) {
    synth.notes = synth.notes
      .filter((n) => n.start < state.length)
      .map((n) => ({ ...n, length: Math.min(n.length, state.length - n.start) }));
  }
}

// --- any track -----------------------------------------------------------------

function requireAny(state, ref) {
  const track = findTrack(state, ref) ?? findSynth(state, ref);
  if (!track) throw new Error(`There is no track "${ref}". Tracks: ${trackList(state)}.`);
  return track;
}

const isSynth = (track) => Array.isArray(track.notes);

// --- state ---------------------------------------------------------------------

export function defaultState() {
  const state = {
    bpm: 100, swing: 50, length: 16, stepsPerBeat: 4, playing: false,
    tracks: [], synths: [], note: null, loop: null,
  };
  for (const id of DEFAULT_KIT) pushTrack(state, id);
  setPattern(state, {
    tracks: { kick: 'x... .... x.x. ....', snare: '.... x... .... x...', closed_hat: 'x.' },
  });
  pushSynth(state, 'bass');
  pushSynth(state, 'keys');
  setNotes(state, {
    track: 'bass',
    notes: [
      { pitch: 'A2', start: 0, length: 2 },
      { pitch: 'A2', start: 3, length: 1 },
      { pitch: 'C3', start: 6, length: 2 },
      { pitch: 'G2', start: 8, length: 2 },
      { pitch: 'G2', start: 11, length: 1 },
      { pitch: 'E2', start: 12, length: 3 },
    ],
  });
  state.note = {
    title: 'Welcome to daw-better',
    body:
      'This is a basic rock beat: kick on beats **1** and **3**, snare on the **backbeat** (2 and 4), ' +
      'and a closed hi-hat on every 8th note, with a simple bass line in the **Piano Roll**.\n\n' +
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
  const volume = (v, fallback) => (Number.isFinite(v) ? clamp(v, [0, 1]) : fallback);
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
        volume: volume(t.volume, 0.8),
        mute: !!t.mute,
        solo: !!t.solo,
        steps: resize(Array.isArray(t.steps) ? t.steps.map((v) => clamp(Number(v) || 0, [0, 1])) : [], state.length),
      }));
  }
  if (Array.isArray(raw.synths)) {
    state.synths = raw.synths
      .filter((s) => s && SYNTHS.some((p) => p.id === s.preset) && typeof s.id === 'string')
      .slice(0, LIMITS.synths)
      .map((s) => ({
        id: s.id,
        name: typeof s.name === 'string' ? s.name : s.id,
        preset: s.preset,
        volume: volume(s.volume, 0.7),
        mute: !!s.mute,
        solo: !!s.solo,
        notes: (Array.isArray(s.notes) ? s.notes : []).flatMap((n) => {
          try {
            return [makeNote(state, n)];
          } catch {
            return [];
          }
        }),
      }));
  } else {
    // Saved before synth tracks existed: keep the empty tracks, not the demo bass line.
    for (const s of state.synths) s.notes = [];
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

// --- edits ---------------------------------------------------------------------

// Replace the drum pattern with a loop from the library (see library.js). Synth tracks
// stay, trimmed if the loop is shorter.
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
  trimNotes(state);
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

export function setNotes(state, { track: ref, notes, replace = true }) {
  if (!Array.isArray(notes)) throw new Error('Give a list of notes.');
  const synth = findOrAddSynth(state, ref);
  const made = notes.map((n) => makeNote(state, n));
  synth.notes = replace ? made : [...synth.notes, ...made];
  sortNotes(synth);
  return replace ? `wrote ${made.length} notes on ${synth.name}` : `added ${made.length} notes to ${synth.name}`;
}

export function addNote(state, { synth: ref, note }) {
  const synth = requireSynth(state, ref);
  const made = makeNote(state, note);
  synth.notes = synth.notes.filter((n) => n.id !== made.id);
  synth.notes.push(made);
  sortNotes(synth);
  return `${synth.name}: added ${noteName(made.pitch)}`;
}

export function updateNote(state, { synth: ref, id, pitch, start, length, velocity }) {
  const synth = requireSynth(state, ref);
  const index = synth.notes.findIndex((n) => n.id === id);
  if (index < 0) throw new Error('That note no longer exists.');
  const old = synth.notes[index];
  const startStep = start ?? old.start;
  const updated = makeNote(state, {
    id,
    pitch: pitch ?? old.pitch,
    start: Number.isInteger(startStep) ? clamp(startStep, [0, Math.max(0, state.length - (length ?? old.length))]) : startStep,
    length: length ?? old.length,
    velocity: velocity ?? old.velocity,
  });
  synth.notes[index] = updated;
  sortNotes(synth);
  return `${synth.name}: edited ${noteName(updated.pitch)}`;
}

export function deleteNotes(state, { synth: ref, ids }) {
  const synth = requireSynth(state, ref);
  const remove = new Set(ids);
  const before = synth.notes.length;
  synth.notes = synth.notes.filter((n) => !remove.has(n.id));
  const removed = before - synth.notes.length;
  return `${synth.name}: deleted ${removed} note${removed === 1 ? '' : 's'}`;
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
    trimNotes(state);
    changes.push(`length ${state.length} steps`);
  }
  if (changes.length === 0) throw new Error('Nothing to change.');
  return changes.join(', ');
}

export function setPlaying(state, { playing }) {
  state.playing = !!playing;
  return state.playing ? 'play' : 'stop';
}

// Works on drum and synth tracks. For a synth track, `instrument` picks its sound.
export function setTrack(state, { track: ref, volume, mute, solo, name, instrument }) {
  const track = requireAny(state, ref);
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
    if (isSynth(track)) {
      const preset = resolveSynth(instrument);
      if (!preset) throw new Error(`Unknown synth sound "${instrument}". Synth sounds: ${synthList()}.`);
      track.preset = preset.id;
      changes.push(`sound ${preset.name}`);
    } else {
      const inst = resolveInstrument(instrument);
      if (!inst) throw new Error(`Unknown instrument "${instrument}". Instruments: ${instrumentList()}.`);
      track.instrument = inst.id;
      changes.push(`sound ${inst.name}`);
    }
  }
  if (name !== undefined && String(name).trim()) {
    changes.push(`renamed from ${track.name}`);
    track.name = String(name).trim();
  }
  if (changes.length === 0) throw new Error('Nothing to change.');
  return `${track.name}: ${changes.join(', ')}`;
}

// `instrument` is a drum instrument or a synth sound; synth sounds add a piano-roll track.
export function addTrack(state, { instrument, name }) {
  const inst = resolveInstrument(instrument);
  if (inst) return `added ${pushTrack(state, inst.id, name).name}`;
  const preset = resolveSynth(instrument);
  if (preset) return `added synth ${pushSynth(state, preset.id, name).name}`;
  throw new Error(`Unknown instrument "${instrument}". Drums: ${instrumentList()}. Synth sounds: ${synthList()}.`);
}

export function removeTrack(state, { track: ref }) {
  const track = requireAny(state, ref);
  const list = isSynth(track) ? state.synths : state.tracks;
  list.splice(list.indexOf(track), 1);
  return `removed ${track.name}`;
}

export function clearTracks(state, { tracks } = {}) {
  const targets = tracks?.length ? tracks.map((ref) => requireAny(state, ref)) : [...state.tracks, ...state.synths];
  for (const t of targets) {
    if (isSynth(t)) t.notes = [];
    else t.steps.fill(0);
  }
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
