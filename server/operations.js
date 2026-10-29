// Every edit goes through these functions, whether it comes from the browser or from Claude.
// Each one mutates `state` in place and returns a short description for the activity log.
// Step indexes are 0-based here.
//
// The project is a set of patterns. Each pattern has drum tracks (pattern.tracks, one velocity
// per step) and synth tracks (pattern.synths, notes for the piano roll), plus its own length,
// subdivision and swing; a note's start and length are measured in the same steps as the
// drums. The sequencer and piano roll show the current pattern (state.current), and the track
// and note edits below apply to it. The arrangement places patterns on the song timeline as
// clips, with positions in beats. The tempo is shared by everything.

import { INSTRUMENTS, DEFAULT_KIT, normalizeName, resolveInstrument } from '../shared/instruments.js';
import { SYNTHS, PITCH_RANGE, noteName, parsePitch, resolveSynth } from '../shared/synths.js';
import { BEATS_PER_BAR, PATTERN_COLORS, patternBeats, barLabel, lengthLabel } from '../shared/patterns.js';
import { parseSteps } from './notation.js';

export const LIMITS = {
  bpm: [30, 300],
  swing: [50, 75],
  length: [1, 64],
  stepsPerBeat: [1, 8],
  tracks: 16,
  synths: 8,
  patterns: 32,
  clips: 256,
  lanes: 16,
  songBeats: 1024,
};

const clamp = (value, [lo, hi]) => Math.min(hi, Math.max(lo, value));

function toNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

function resize(steps, length) {
  return Array.from({ length }, (_, i) => steps[i] ?? 0);
}

let idCount = 0;
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(++idCount).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const validId = (id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id);

// --- patterns ------------------------------------------------------------------

export function currentPattern(state) {
  return state.patterns.find((p) => p.id === state.current) ?? state.patterns[0];
}

const cleanName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
const isDefaultName = (name) => /^Pattern \d+$/.test(name);
const patternList = (state) => state.patterns.map((p) => `"${p.name}" (${p.id})`).join(', ');

// Pattern names are unique, so Claude and the user can refer to patterns by name. A name
// that's taken gets a number: "Groove" becomes "Groove 2".
function uniqueName(state, name, except) {
  const taken = new Set(state.patterns.filter((p) => p !== except).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const stem = name.replace(/ \d+$/, '');
  let n = 2;
  while (taken.has(`${stem} ${n}`.toLowerCase())) n++;
  return `${stem} ${n}`;
}

/** A pattern by id ("p2"), name ("Verse") or position in the list ("2"). */
export function findPattern(state, ref) {
  const key = String(ref ?? '').trim();
  return (
    state.patterns.find((p) => p.id === key) ??
    state.patterns.find((p) => p.name.toLowerCase() === key.toLowerCase()) ??
    (/^\d+$/.test(key) ? state.patterns[Number(key) - 1] : undefined) ??
    null
  );
}

function requirePattern(state, ref) {
  const pattern = findPattern(state, ref);
  if (!pattern) throw new Error(`There is no pattern "${ref}". Patterns: ${patternList(state)}.`);
  return pattern;
}

function pushPattern(state, name) {
  if (state.patterns.length >= LIMITS.patterns) throw new Error(`A project holds at most ${LIMITS.patterns} patterns.`);
  const n = Math.max(0, ...state.patterns.map((p) => Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0))) + 1;
  const pattern = {
    id: `p${n}`,
    name: uniqueName(state, cleanName(name) || `Pattern ${n}`),
    color: (n - 1) % PATTERN_COLORS.length,
    length: 16,
    stepsPerBeat: 4,
    swing: 50,
    tracks: [],
    synths: [],
    loop: null,
  };
  state.patterns.push(pattern);
  return pattern;
}

// A pattern takes the name of a library loop loaded into it or saved from it, unless the
// user has named it themselves.
function nameAfterLoop(state, pattern, name) {
  if (isDefaultName(pattern.name) || pattern.name === pattern.loop?.name) pattern.name = uniqueName(state, name, pattern);
}

// --- drum tracks ---------------------------------------------------------------

// Drum and synth tracks share one id space within a pattern, so any track can be referred to by id.
function uniqueId(pattern, name, fallback) {
  const base = (name && normalizeName(name).replace(/[^a-z0-9_]/g, '')) || fallback;
  const taken = new Set([...pattern.tracks, ...pattern.synths].map((t) => t.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

const trackList = (pattern) => [...pattern.tracks, ...pattern.synths].map((t) => t.id).join(', ') || '(none)';
const instrumentList = () => INSTRUMENTS.map((i) => i.id).join(', ');
const synthList = () => SYNTHS.map((s) => s.id).join(', ');

export function findTrack(pattern, ref) {
  const key = normalizeName(ref);
  const direct = pattern.tracks.find((t) => t.id === key || normalizeName(t.name) === key);
  if (direct) return direct;
  const inst = resolveInstrument(ref);
  return inst ? (pattern.tracks.find((t) => t.instrument === inst.id) ?? null) : null;
}

function requireTrack(pattern, ref) {
  const track = findTrack(pattern, ref);
  if (!track) throw new Error(`There is no drum track "${ref}". Tracks: ${trackList(pattern)}.`);
  return track;
}

// Writing hits to an instrument that has no track yet adds the track.
function findOrAddTrack(pattern, ref) {
  const track = findTrack(pattern, ref);
  if (track) return track;
  const inst = resolveInstrument(ref);
  if (!inst) {
    throw new Error(`There is no track or instrument "${ref}". Tracks: ${trackList(pattern)}. Instruments: ${instrumentList()}.`);
  }
  return pushTrack(pattern, inst.id);
}

function pushTrack(pattern, instrumentId, name) {
  if (pattern.tracks.length >= LIMITS.tracks) throw new Error(`A pattern holds at most ${LIMITS.tracks} drum tracks.`);
  const inst = INSTRUMENTS.find((i) => i.id === instrumentId);
  const track = {
    id: uniqueId(pattern, name, inst.id),
    name: name?.trim() || inst.name,
    instrument: inst.id,
    volume: 0.8,
    mute: false,
    solo: false,
    steps: new Array(pattern.length).fill(0),
  };
  pattern.tracks.push(track);
  return track;
}

// --- synth tracks --------------------------------------------------------------

export function findSynth(pattern, ref) {
  const key = normalizeName(ref);
  const direct = pattern.synths.find((s) => s.id === key || normalizeName(s.name) === key);
  if (direct) return direct;
  const preset = resolveSynth(ref);
  return preset ? (pattern.synths.find((s) => s.preset === preset.id) ?? null) : null;
}

function requireSynth(pattern, ref) {
  const synth = findSynth(pattern, ref);
  if (!synth) throw new Error(`There is no synth track "${ref}". Synth tracks: ${pattern.synths.map((s) => s.id).join(', ') || '(none)'}.`);
  return synth;
}

// Writing notes for a synth sound that has no track yet adds the track.
function findOrAddSynth(pattern, ref) {
  const synth = findSynth(pattern, ref);
  if (synth) return synth;
  const preset = resolveSynth(ref);
  if (!preset) throw new Error(`There is no synth track or sound "${ref}". Synth sounds: ${synthList()}.`);
  return pushSynth(pattern, preset.id);
}

function pushSynth(pattern, presetId, name) {
  if (pattern.synths.length >= LIMITS.synths) throw new Error(`A pattern holds at most ${LIMITS.synths} synth tracks.`);
  const preset = SYNTHS.find((s) => s.id === presetId);
  const synth = {
    id: uniqueId(pattern, name, preset.id),
    name: name?.trim() || preset.name,
    preset: preset.id,
    volume: 0.7,
    mute: false,
    solo: false,
    notes: [],
  };
  pattern.synths.push(synth);
  return synth;
}

function makeNote(pattern, { id, pitch, start, length = 1, velocity = 0.8 }) {
  const midi = parsePitch(pitch);
  if (midi === null || midi < PITCH_RANGE[0] || midi > PITCH_RANGE[1]) {
    throw new Error(`"${pitch}" isn't a note between C1 and C7. Use a name like "A2", "F#4" or "Bb3" (C4 is middle C).`);
  }
  if (!Number.isInteger(start) || start < 0 || start >= pattern.length) {
    throw new Error(`A note can't start on step ${start + 1}; the pattern has steps 1-${pattern.length}.`);
  }
  return {
    id: validId(id) ? id : newId('n'),
    pitch: midi,
    start,
    length: Math.round(clamp(toNumber(length, 'length'), [1, pattern.length - start])),
    velocity: clamp(toNumber(velocity, 'velocity'), [0, 1]),
  };
}

function sortNotes(synth) {
  synth.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// After the pattern gets shorter, drop notes that start past the end and shorten the rest.
function trimNotes(pattern) {
  for (const synth of pattern.synths) {
    synth.notes = synth.notes
      .filter((n) => n.start < pattern.length)
      .map((n) => ({ ...n, length: Math.min(n.length, pattern.length - n.start) }));
  }
}

// --- any track -----------------------------------------------------------------

function requireAny(pattern, ref) {
  const track = findTrack(pattern, ref) ?? findSynth(pattern, ref);
  if (!track) throw new Error(`There is no track "${ref}". Tracks: ${trackList(pattern)}.`);
  return track;
}

const isSynth = (track) => Array.isArray(track.notes);

// --- arrangement ---------------------------------------------------------------

const songEnd = (state) => Math.max(0, ...state.arrangement.map((c) => c.start + c.length));
const clipName = (state, clip) => state.patterns.find((p) => p.id === clip.pattern)?.name ?? clip.pattern;

// Where a clip goes when no lane is given: the lane its pattern already plays on, if that's
// free for the clip's whole length, otherwise the first free lane.
function freeLane(state, patternId, start, length) {
  const free = (lane) => !state.arrangement.some((c) => c.lane === lane && c.start < start + length && start < c.start + c.length);
  const own = state.arrangement.find((c) => c.pattern === patternId)?.lane;
  if (own !== undefined && free(own)) return own;
  for (let lane = 0; lane < LIMITS.lanes; lane++) if (free(lane)) return lane;
  return own ?? 0;
}

// A clip plays its pattern from `start` for `length` beats, repeating the pattern if the clip
// is longer. Without a start it goes after the end of the song, on the next bar line.
function makeClip(state, { id, pattern: ref, lane, start, length }) {
  const pattern = requirePattern(state, ref);
  start ??= Math.ceil(songEnd(state) / BEATS_PER_BAR) * BEATS_PER_BAR;
  length ??= patternBeats(pattern);
  if (!Number.isInteger(start) || start < 0) throw new Error(`A clip can't start at beat ${start}; positions are whole beats from 0.`);
  if (!Number.isInteger(length) || length < 1) throw new Error('A clip lasts a whole number of beats, at least one.');
  if (start + length > LIMITS.songBeats) throw new Error(`A song can be at most ${LIMITS.songBeats / BEATS_PER_BAR} bars long.`);
  lane ??= freeLane(state, pattern.id, start, length);
  if (!Number.isInteger(lane) || lane < 0 || lane >= LIMITS.lanes) throw new Error(`Lanes are numbered 1 to ${LIMITS.lanes}.`);
  return { id: validId(id) ? id : newId('c'), pattern: pattern.id, lane, start, length };
}

function sortClips(state) {
  state.arrangement.sort((a, b) => a.start - b.start || a.lane - b.lane);
}

// --- state ---------------------------------------------------------------------

export function defaultState() {
  const state = { bpm: 100, playing: false, mode: 'pattern', patterns: [], current: null, arrangement: [], note: null };
  const pattern = pushPattern(state);
  state.current = pattern.id;
  for (const id of DEFAULT_KIT) pushTrack(pattern, id);
  setPattern(state, {
    tracks: { kick: 'x... .... x.x. ....', snare: '.... x... .... x...', closed_hat: 'x.' },
  });
  pushSynth(pattern, 'bass');
  pushSynth(pattern, 'keys');
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
  addClip(state, { pattern: pattern.id, lane: 0, start: 0, length: 4 * BEATS_PER_BAR });
  state.note = {
    title: 'Welcome to daw-better',
    body:
      'This is a basic rock beat: kick on beats **1** and **3**, snare on the **backbeat** (2 and 4), ' +
      'and a closed hi-hat on every 8th note, with a simple bass line in the **Piano Roll**.\n\n' +
      'Press **Space** to play. Click cells to edit, pick a genre loop in the **Browser**, ' +
      'or ask Claude to write a groove, explain one, or quiz you. To build a song, make more ' +
      'patterns with **+**, place them in the **Playlist** and switch to **Song**.',
    highlights: [{ track: 'snare', steps: [4, 12] }],
    pattern: pattern.id,
  };
  return state;
}

const number = (v, limits, fallback) => (Number.isFinite(v) ? Math.round(clamp(v, limits)) : fallback);
const level = (v, fallback) => (Number.isFinite(v) ? clamp(v, [0, 1]) : fallback);

function sanitizePattern(raw) {
  const pattern = {
    id: raw.id,
    name: cleanName(raw.name) || raw.id,
    color: Number.isInteger(raw.color) ? Math.abs(raw.color) % PATTERN_COLORS.length : 0,
    length: number(raw.length, LIMITS.length, 16),
    stepsPerBeat: number(raw.stepsPerBeat, LIMITS.stepsPerBeat, 4),
    swing: number(raw.swing, LIMITS.swing, 50),
    tracks: [],
    synths: [],
    loop: typeof raw.loop?.id === 'string' ? { id: raw.loop.id, name: String(raw.loop.name ?? raw.loop.id) } : null,
  };
  if (Array.isArray(raw.tracks)) {
    pattern.tracks = raw.tracks
      .filter((t) => t && INSTRUMENTS.some((i) => i.id === t.instrument) && typeof t.id === 'string')
      .slice(0, LIMITS.tracks)
      .map((t) => ({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : t.id,
        instrument: t.instrument,
        volume: level(t.volume, 0.8),
        mute: !!t.mute,
        solo: !!t.solo,
        steps: resize(Array.isArray(t.steps) ? t.steps.map((v) => clamp(Number(v) || 0, [0, 1])) : [], pattern.length),
      }));
  }
  if (Array.isArray(raw.synths)) {
    pattern.synths = raw.synths
      .filter((s) => s && SYNTHS.some((p) => p.id === s.preset) && typeof s.id === 'string')
      .slice(0, LIMITS.synths)
      .map((s) => ({
        id: s.id,
        name: typeof s.name === 'string' ? s.name : s.id,
        preset: s.preset,
        volume: level(s.volume, 0.7),
        mute: !!s.mute,
        solo: !!s.solo,
        notes: (Array.isArray(s.notes) ? s.notes : []).flatMap((n) => {
          try {
            return [makeNote(pattern, n)];
          } catch {
            return [];
          }
        }),
      }));
  }
  return pattern;
}

// Rebuild a state loaded from disk, keeping only valid fields.
export function sanitize(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;
  state.bpm = number(raw.bpm, LIMITS.bpm, state.bpm);
  state.mode = raw.mode === 'song' ? 'song' : 'pattern';

  // Saved before there were several patterns: the one pattern's fields are at the top level.
  const list = Array.isArray(raw.patterns) ? raw.patterns : [{ ...raw, id: 'p1', name: raw.loop?.name ?? 'Pattern 1', color: 0 }];
  const patterns = [];
  for (const p of list) {
    if (patterns.length === LIMITS.patterns) break;
    if (p && typeof p === 'object' && validId(p.id) && !patterns.some((q) => q.id === p.id)) patterns.push(sanitizePattern(p));
  }
  if (patterns.length) {
    state.patterns = patterns;
    state.current = patterns.some((p) => p.id === raw.current) ? raw.current : patterns[0].id;
  }

  if (Array.isArray(raw.arrangement)) {
    state.arrangement = [];
    for (const c of raw.arrangement.slice(0, LIMITS.clips)) {
      if (!state.patterns.some((p) => p.id === c?.pattern)) continue;
      try {
        state.arrangement.push(makeClip(state, { id: c.id, pattern: c.pattern, lane: c.lane, start: c.start, length: c.length }));
      } catch {
        // Skip a clip that doesn't fit the song.
      }
    }
    sortClips(state);
  }
  state.arrangement = state.arrangement.filter((c) => state.patterns.some((p) => p.id === c.pattern));

  const note = raw.note;
  state.note =
    note && typeof note.body === 'string'
      ? {
          title: typeof note.title === 'string' ? note.title : '',
          body: note.body,
          highlights: (Array.isArray(note.highlights) ? note.highlights : [])
            .filter((h) => typeof h?.track === 'string' && Array.isArray(h.steps))
            .map((h) => ({ track: h.track, steps: h.steps.filter(Number.isInteger) })),
          pattern: typeof note.pattern === 'string' ? note.pattern : state.current,
        }
      : null;
  return state;
}

// --- library loops -------------------------------------------------------------

// Put a loop from the library (see library.js) into the current pattern, or with `asNew` into
// a new pattern. Loading over the current pattern also sets the tempo; a new pattern joins a
// song that already has one. A loop with synth parts replaces the synth tracks too; otherwise
// they stay, trimmed if the loop is shorter.
export function loadLoop(state, loop, { asNew = false } = {}) {
  const pattern = asNew ? pushPattern(state, loop.name) : currentPattern(state);
  if (!asNew) state.bpm = loop.bpm;
  pattern.swing = loop.swing;
  pattern.stepsPerBeat = loop.stepsPerBeat;
  pattern.length = loop.length;
  pattern.tracks = [];
  if (loop.synths.length) pattern.synths = [];
  for (const t of loop.tracks) {
    const track = pushTrack(pattern, t.instrument, t.name);
    track.volume = t.volume;
    track.steps = [...t.steps];
  }
  for (const s of loop.synths) {
    const synth = pushSynth(pattern, s.preset, s.name);
    synth.volume = s.volume;
    synth.notes = s.notes.map((n) => makeNote(pattern, n));
  }
  trimNotes(pattern);
  nameAfterLoop(state, pattern, loop.name);
  pattern.loop = { id: loop.id, name: loop.name };
  state.current = pattern.id;
  if (!asNew) return `loaded ${loop.folder} / ${loop.name}`;
  const tempo = loop.bpm === state.bpm ? '' : ` (it was made at ${loop.bpm} BPM; the tempo stays at ${state.bpm})`;
  return `added ${loop.folder} / ${loop.name} as the pattern ${pattern.name}${tempo}`;
}

// After a save the pattern counts as that library loop, like a document after "Save as".
export function markSaved(state, { id, name, folder, replaced }) {
  const pattern = currentPattern(state);
  nameAfterLoop(state, pattern, name);
  pattern.loop = { id, name };
  return `saved the pattern ${replaced ? 'over' : 'as'} ${folder} / ${name}`;
}

// A library loop moved to another folder: patterns that came from it keep pointing at it.
export function loopMoved(state, { from, id, name, folder }) {
  for (const pattern of state.patterns) {
    if (pattern.loop?.id.toLowerCase() === from.toLowerCase()) pattern.loop = { ...pattern.loop, id };
  }
  return `moved ${name} to ${folder}`;
}

// --- pattern edits -------------------------------------------------------------

// A new pattern has the current pattern's instruments with nothing written; with `copy` it's
// a full copy, to make a variation. Either way it becomes the current pattern.
export function newPattern(state, { name, copy = false } = {}) {
  const source = currentPattern(state);
  const pattern = pushPattern(state, cleanName(name) || (copy && !isDefaultName(source.name) ? source.name : ''));
  Object.assign(pattern, { length: source.length, stepsPerBeat: source.stepsPerBeat, swing: source.swing });
  pattern.tracks = source.tracks.map((t) => ({ ...t, steps: copy ? [...t.steps] : new Array(source.length).fill(0) }));
  pattern.synths = source.synths.map((s) => ({ ...s, notes: copy ? s.notes.map((n) => ({ ...n })) : [] }));
  state.current = pattern.id;
  return copy ? `copied ${source.name} to a new pattern, ${pattern.name}` : `made a new pattern, ${pattern.name}`;
}

export function selectPattern(state, { pattern: ref }) {
  const pattern = requirePattern(state, ref);
  state.current = pattern.id;
  return `switched to ${pattern.name}`;
}

export function renamePattern(state, { pattern: ref, name }) {
  const pattern = ref === undefined ? currentPattern(state) : requirePattern(state, ref);
  const clean = cleanName(name);
  if (!clean) throw new Error('Give the pattern a name.');
  if (state.patterns.some((p) => p !== pattern && p.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`There's already a pattern called "${clean}".`);
  }
  const old = pattern.name;
  pattern.name = clean;
  return `renamed ${old} to ${clean}`;
}

// Deleting a pattern removes its clips from the arrangement too.
export function deletePattern(state, { pattern: ref }) {
  const pattern = requirePattern(state, ref);
  if (state.patterns.length === 1) throw new Error("The last pattern can't be deleted.");
  const index = state.patterns.indexOf(pattern);
  state.patterns.splice(index, 1);
  const clips = state.arrangement.filter((c) => c.pattern === pattern.id).length;
  state.arrangement = state.arrangement.filter((c) => c.pattern !== pattern.id);
  if (state.current === pattern.id) state.current = (state.patterns[index] ?? state.patterns[index - 1]).id;
  return `deleted ${pattern.name}${clips ? ` and its ${clips} clip${clips === 1 ? '' : 's'}` : ''}`;
}

// --- arrangement edits ---------------------------------------------------------

export function addClip(state, args) {
  state.arrangement = state.arrangement.filter((c) => c.id !== args.id);
  if (state.arrangement.length >= LIMITS.clips) throw new Error(`The arrangement holds at most ${LIMITS.clips} clips.`);
  const clip = makeClip(state, args);
  state.arrangement.push(clip);
  sortClips(state);
  return `placed ${clipName(state, clip)} at ${barLabel(clip.start)}, lane ${clip.lane + 1}`;
}

export function updateClip(state, { id, lane, start, length }) {
  const index = state.arrangement.findIndex((c) => c.id === id);
  if (index < 0) throw new Error('That clip no longer exists.');
  const old = state.arrangement[index];
  const clip = makeClip(state, { id, pattern: old.pattern, lane: lane ?? old.lane, start: start ?? old.start, length: length ?? old.length });
  state.arrangement[index] = clip;
  sortClips(state);
  if (clip.length !== old.length) return `${clipName(state, clip)} at ${barLabel(clip.start)} now plays for ${lengthLabel(clip.length)}`;
  return `moved ${clipName(state, clip)} to ${barLabel(clip.start)}, lane ${clip.lane + 1}`;
}

export function deleteClips(state, { ids }) {
  const remove = new Set(ids);
  const removed = state.arrangement.filter((c) => remove.has(c.id));
  state.arrangement = state.arrangement.filter((c) => !remove.has(c.id));
  if (removed.length === 1) return `removed ${clipName(state, removed[0])} from ${barLabel(removed[0].start)}`;
  return `removed ${removed.length} clips`;
}

// Place several clips at once (Claude's arrange tool), after clearing the arrangement with `replace`.
export function arrange(state, { clips, replace = false }) {
  if (!Array.isArray(clips)) throw new Error('Give a list of clips.');
  if (!replace && clips.length === 0) throw new Error('Give at least one clip, or use replace to clear the arrangement.');
  if (replace) state.arrangement = [];
  const placed = clips.map((clip) => addClip(state, clip));
  if (replace) return clips.length ? `rewrote the arrangement with ${clips.length} clip${clips.length === 1 ? '' : 's'}` : 'cleared the arrangement';
  return placed.length === 1 ? placed[0] : `placed ${placed.length} clips`;
}

// Pattern mode loops the current pattern; song mode plays the arrangement.
export function setMode(state, { mode }) {
  if (mode !== 'pattern' && mode !== 'song') throw new Error('The mode is "pattern" or "song".');
  state.mode = mode;
  return `switched to ${mode} mode`;
}

// --- track and note edits (current pattern) ------------------------------------

export function setPattern(state, { tracks, clearOthers = false }) {
  const pattern = currentPattern(state);
  const entries = Object.entries(tracks ?? {});
  if (entries.length === 0) throw new Error('Give at least one track.');
  const written = [];
  for (const [ref, text] of entries) {
    const track = findOrAddTrack(pattern, ref);
    track.steps = parseSteps(text, pattern.length);
    written.push(track);
  }
  if (clearOthers) {
    for (const t of pattern.tracks) if (!written.includes(t)) t.steps.fill(0);
  }
  return `wrote ${written.map((t) => t.name).join(', ')}${clearOthers ? ' and cleared the rest' : ''}`;
}

export function setSteps(state, { track: ref, steps }) {
  const pattern = currentPattern(state);
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('Give at least one step.');
  const track = findOrAddTrack(pattern, ref);
  for (const { step, velocity } of steps) {
    if (!Number.isInteger(step) || step < 0 || step >= pattern.length) {
      throw new Error(`Step ${step + 1} is out of range; the pattern has steps 1-${pattern.length}.`);
    }
    track.steps[step] = clamp(toNumber(velocity, 'velocity'), [0, 1]);
  }
  if (steps.length === 1) return `${track.name} step ${steps[0].step + 1} ${steps[0].velocity > 0 ? 'on' : 'off'}`;
  return `edited ${steps.length} steps on ${track.name}`;
}

export function setNotes(state, { track: ref, notes, replace = true }) {
  const pattern = currentPattern(state);
  if (!Array.isArray(notes)) throw new Error('Give a list of notes.');
  const synth = findOrAddSynth(pattern, ref);
  const made = notes.map((n) => makeNote(pattern, n));
  synth.notes = replace ? made : [...synth.notes, ...made];
  sortNotes(synth);
  return replace ? `wrote ${made.length} notes on ${synth.name}` : `added ${made.length} notes to ${synth.name}`;
}

export function addNote(state, { synth: ref, note }) {
  const pattern = currentPattern(state);
  const synth = requireSynth(pattern, ref);
  const made = makeNote(pattern, note);
  synth.notes = synth.notes.filter((n) => n.id !== made.id);
  synth.notes.push(made);
  sortNotes(synth);
  return `${synth.name}: added ${noteName(made.pitch)}`;
}

export function updateNote(state, { synth: ref, id, pitch, start, length, velocity }) {
  const pattern = currentPattern(state);
  const synth = requireSynth(pattern, ref);
  const index = synth.notes.findIndex((n) => n.id === id);
  if (index < 0) throw new Error('That note no longer exists.');
  const old = synth.notes[index];
  const startStep = start ?? old.start;
  const updated = makeNote(pattern, {
    id,
    pitch: pitch ?? old.pitch,
    start: Number.isInteger(startStep) ? clamp(startStep, [0, Math.max(0, pattern.length - (length ?? old.length))]) : startStep,
    length: length ?? old.length,
    velocity: velocity ?? old.velocity,
  });
  synth.notes[index] = updated;
  sortNotes(synth);
  return `${synth.name}: edited ${noteName(updated.pitch)}`;
}

export function deleteNotes(state, { synth: ref, ids }) {
  const synth = requireSynth(currentPattern(state), ref);
  const remove = new Set(ids);
  const before = synth.notes.length;
  synth.notes = synth.notes.filter((n) => !remove.has(n.id));
  const removed = before - synth.notes.length;
  return `${synth.name}: deleted ${removed} note${removed === 1 ? '' : 's'}`;
}

// The tempo is the song's; swing, length and subdivision belong to the current pattern.
export function setTransport(state, { bpm, swing, length, stepsPerBeat }) {
  const pattern = currentPattern(state);
  const changes = [];
  if (bpm !== undefined) {
    state.bpm = Math.round(clamp(toNumber(bpm, 'bpm'), LIMITS.bpm));
    changes.push(`tempo ${state.bpm} BPM`);
  }
  if (swing !== undefined) {
    pattern.swing = Math.round(clamp(toNumber(swing, 'swing'), LIMITS.swing));
    changes.push(`swing ${pattern.swing}%`);
  }
  if (stepsPerBeat !== undefined) {
    pattern.stepsPerBeat = Math.round(clamp(toNumber(stepsPerBeat, 'steps per beat'), LIMITS.stepsPerBeat));
    changes.push(`${pattern.stepsPerBeat} steps per beat`);
  }
  if (length !== undefined) {
    pattern.length = Math.round(clamp(toNumber(length, 'length'), LIMITS.length));
    for (const t of pattern.tracks) t.steps = resize(t.steps, pattern.length);
    trimNotes(pattern);
    changes.push(`length ${pattern.length} steps`);
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
  const track = requireAny(currentPattern(state), ref);
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
  const pattern = currentPattern(state);
  const inst = resolveInstrument(instrument);
  if (inst) return `added ${pushTrack(pattern, inst.id, name).name}`;
  const preset = resolveSynth(instrument);
  if (preset) return `added synth ${pushSynth(pattern, preset.id, name).name}`;
  throw new Error(`Unknown instrument "${instrument}". Drums: ${instrumentList()}. Synth sounds: ${synthList()}.`);
}

export function removeTrack(state, { track: ref }) {
  const pattern = currentPattern(state);
  const track = requireAny(pattern, ref);
  const list = isSynth(track) ? pattern.synths : pattern.tracks;
  list.splice(list.indexOf(track), 1);
  return `removed ${track.name}`;
}

export function clearTracks(state, { tracks } = {}) {
  const pattern = currentPattern(state);
  const targets = tracks?.length ? tracks.map((ref) => requireAny(pattern, ref)) : [...pattern.tracks, ...pattern.synths];
  for (const t of targets) {
    if (isSynth(t)) t.notes = [];
    else t.steps.fill(0);
  }
  return tracks?.length ? `cleared ${targets.map((t) => t.name).join(', ')}` : `cleared every track in ${pattern.name}`;
}

// The note's highlights point at steps of the current pattern, and only show while it's current.
export function setNote(state, { title, body, highlights }) {
  if (!body?.trim()) {
    state.note = null;
    return 'removed the note';
  }
  const pattern = currentPattern(state);
  state.note = {
    title: title?.trim() ?? '',
    body: body.trim(),
    highlights: (highlights ?? []).map((h) => ({
      track: requireTrack(pattern, h.track).id,
      steps: h.steps.filter((s) => Number.isInteger(s) && s >= 0 && s < pattern.length),
    })),
    pattern: pattern.id,
  };
  return `note: ${state.note.title || state.note.body.slice(0, 48)}`;
}
