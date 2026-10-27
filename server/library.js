// The loop library: folders of patterns, stored as JSON files under library/<Folder>/<loop>.json.
// It ships with genre folders of ready-made grooves, and the Browser window (or Claude) can
// save the current pattern into it, make folders and rearrange loops. The folders are read on
// every request, so loops added by hand show up without restarting the server.
//
// A loop file looks like:
//   {
//     "name": "Four on the Floor",
//     "description": "What to listen for.",
//     "bpm": 120, "swing": 50, "stepsPerBeat": 4, "length": 16,
//     "tracks": {
//       "kick": "x... x... x... x...",
//       "Ghost Snare": { "instrument": "snare", "steps": ".o.. ...o", "volume": 0.5 }
//     },
//     "synths": {
//       "bass": "A2@1+2 C3@7+2 G2@9+2",
//       "Chords": { "instrument": "keys", "notes": "C4@1+8 E4@1+8 G4@1+8", "volume": 0.6 }
//     }
//   }
// Drum tracks use the step notation of the MCP tools and synth tracks the pitch@step+length
// note notation (see notation.js); "synths" is optional. A folder's .order.json lists its
// loops in the order they were arranged in.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { INSTRUMENTS, resolveInstrument } from '../shared/instruments.js';
import { SYNTHS, resolveSynth } from '../shared/synths.js';
import { parseSteps, parseNotes, formatSteps, formatNotes } from './notation.js';
import { LIMITS } from './operations.js';

const ORDER_FILE = '.order.json';
// Device names Windows won't accept as file or folder names.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const stemOf = (id) => id.slice(id.indexOf('/') + 1);

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function number(value, [lo, hi], fallback) {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}

// File name for a new loop: "Boom Bap (Slow)" -> "boom-bap-slow".
function slug(name) {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .slice(0, 50)
      .replace(/^-+|-+$/g, '') || 'loop';
  return RESERVED.test(base) ? `${base}-loop` : base;
}

// A track's display name when its entry has no "name": the sound's own name when the key is
// the sound (or a nickname for it, like "hh"), otherwise the key itself.
function defaultName(key, sound, resolve) {
  return resolve(key)?.id === sound.id ? sound.name : key;
}

function normalizeLoop(id, raw) {
  const length = Math.round(number(raw.length, LIMITS.length, 16));
  const tracks = Object.entries(raw.tracks ?? {}).map(([key, spec]) => {
    const def = typeof spec === 'string' ? { steps: spec } : spec;
    const inst = resolveInstrument(def.instrument ?? key);
    if (!inst) throw new Error(`unknown instrument "${def.instrument ?? key}"`);
    return {
      name: def.name ?? defaultName(key, inst, resolveInstrument),
      instrument: inst.id,
      volume: number(def.volume, [0, 1], 0.8),
      steps: parseSteps(def.steps, length),
    };
  });
  const synths = Object.entries(raw.synths ?? {}).map(([key, spec]) => {
    const def = typeof spec === 'string' ? { notes: spec } : spec;
    const preset = resolveSynth(def.instrument ?? key);
    if (!preset) throw new Error(`unknown synth sound "${def.instrument ?? key}"`);
    return {
      name: def.name ?? defaultName(key, preset, resolveSynth),
      preset: preset.id,
      volume: number(def.volume, [0, 1], 0.7),
      notes: parseNotes(def.notes ?? '', length),
    };
  });
  if (tracks.length + synths.length === 0) throw new Error('it has no tracks');
  if (tracks.length > LIMITS.tracks) throw new Error(`it has more than ${LIMITS.tracks} tracks`);
  if (synths.length > LIMITS.synths) throw new Error(`it has more than ${LIMITS.synths} synth tracks`);

  return {
    id,
    folder: id.slice(0, id.indexOf('/')),
    name: typeof raw.name === 'string' ? raw.name : stemOf(id),
    description: typeof raw.description === 'string' ? raw.description : '',
    bpm: Math.round(number(raw.bpm, LIMITS.bpm, 100)),
    swing: Math.round(number(raw.swing, LIMITS.swing, 50)),
    stepsPerBeat: Math.round(number(raw.stepsPerBeat, LIMITS.stepsPerBeat, 4)),
    length,
    tracks,
    synths,
  };
}

// Tracks are keyed by their sound ("kick", "bass") while they carry its name, and otherwise
// by their own name, with "instrument" naming the sound. A track with nothing but its
// steps or notes is written as a plain string, like the hand-written loops.
function trackEntries(tracks, sounds, resolve, soundOf, defaultVolume, content) {
  const entries = {};
  for (const track of tracks) {
    const sound = sounds.find((s) => s.id === soundOf(track));
    let key = track.name === sound.name && !Object.hasOwn(entries, sound.id) ? sound.id : track.name;
    for (let n = 2; Object.hasOwn(entries, key); n++) key = `${track.name} ${n}`;
    const spec = {};
    if (key !== sound.id) spec.instrument = sound.id;
    if (defaultName(key, sound, resolve) !== track.name) spec.name = track.name;
    const volume = Math.round(track.volume * 100) / 100;
    if (volume !== defaultVolume) spec.volume = volume;
    const [field, value] = content(track);
    entries[key] = Object.keys(spec).length ? { ...spec, [field]: value } : value;
  }
  return entries;
}

/** The pattern as a loop file, in the same format as the hand-written ones. */
export function loopFile(state, { name, description }) {
  const title = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!title) throw fail(400, 'Give the loop a name.');
  if (title.length > 60) throw fail(400, 'Loop names can be at most 60 characters.');
  // Synth tracks are saved when any of them has notes; a loop without them leaves the
  // listener's synth tracks alone when it's loaded.
  const synths = state.synths.some((s) => s.notes.length) ? state.synths : [];
  if (state.tracks.length + synths.length === 0) throw fail(400, 'There is nothing to save: the pattern has no drum tracks and no notes.');

  const file = { name: title };
  const text = String(description ?? '').trim();
  if (text) file.description = text.slice(0, 500);
  Object.assign(file, { bpm: state.bpm, swing: state.swing, stepsPerBeat: state.stepsPerBeat, length: state.length });
  file.tracks = trackEntries(state.tracks, INSTRUMENTS, resolveInstrument, (t) => t.instrument, 0.8, (t) => [
    'steps',
    formatSteps(t.steps, state.stepsPerBeat, true),
  ]);
  if (synths.length) {
    file.synths = trackEntries(synths, SYNTHS, resolveSynth, (s) => s.preset, 0.7, (s) => ['notes', formatNotes(s.notes)]);
  }
  return file;
}

/** Emits 'change' after every edit, so open Browser windows can reload. */
export class Library extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
  }

  folders() {
    return readDir(this.dir)
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** A folder's loops in the order they were arranged in. Broken files are skipped with a warning. */
  loops(folder) {
    const loops = [];
    for (const file of readDir(path.join(this.dir, folder))) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name.startsWith('.')) continue;
      const id = `${folder}/${file.name.slice(0, -'.json'.length)}`;
      try {
        loops.push(normalizeLoop(id, JSON.parse(fs.readFileSync(path.join(this.dir, folder, file.name), 'utf8'))));
      } catch (err) {
        console.warn(`Skipping loop ${id}: ${err.message}`);
      }
    }
    // Arranged loops first, then any that were added another way (by hand, say), by name.
    const order = this.readOrder(folder);
    const rank = (loop) => {
      const i = order.indexOf(stemOf(loop.id));
      return i < 0 ? Infinity : i;
    };
    return loops.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** Every folder with its loops; folders by name, loops as arranged. */
  list() {
    return this.folders().map((name) => ({ name, loops: this.loops(name) }));
  }

  /** Look a loop up by id ("Rock/basic-rock-beat"), ignoring case. Only listed loops can be loaded. */
  get(id) {
    const key = String(id).trim().toLowerCase();
    const loop = this.list()
      .flatMap((f) => f.loops)
      .find((l) => l.id.toLowerCase() === key);
    if (!loop) throw fail(404, `There is no loop "${id}" in the library. Use list_loops to see what's there.`);
    return loop;
  }

  /** The folder's name as it's stored, matched ignoring case, or null. */
  findFolder(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return this.folders().find((f) => f.toLowerCase() === key) ?? null;
  }

  requireFolder(name) {
    const folder = this.findFolder(name);
    if (!folder) throw fail(404, `There is no folder "${name}" in the library.`);
    return folder;
  }

  createFolder(raw) {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw fail(400, 'Give the folder a name.');
    if (name.length > 40) throw fail(400, 'Folder names can be at most 40 characters.');
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.|\.$/.test(name) || RESERVED.test(name)) {
      throw fail(400, `"${name}" can't be a folder name. Leave out \\ / : * ? " < > | and dots at the start or end.`);
    }
    const existing = this.findFolder(name);
    if (existing) throw fail(409, `There is already a folder called ${existing}.`);
    fs.mkdirSync(path.join(this.dir, name), { recursive: true });
    this.emit('change');
    return name;
  }

  /**
   * Write a loop file (see loopFile) into a folder. New loops go at the end of the folder.
   * A loop with the same name in that folder is only replaced with `overwrite`.
   */
  save(folderName, file, { overwrite = false } = {}) {
    const folder = this.requireFolder(folderName);
    const loops = this.loops(folder);
    const existing = loops.find((l) => l.name.toLowerCase() === file.name.toLowerCase());
    if (existing && !overwrite) {
      throw fail(409, `${folder} already has a loop called “${existing.name}”. Choose another name, or replace it.`);
    }
    const stem = existing ? stemOf(existing.id) : this.freeStem(folder, slug(file.name));
    const id = `${folder}/${stem}`;
    try {
      normalizeLoop(id, file); // it has to load again later
    } catch (err) {
      throw fail(400, `Can't save this pattern: ${err.message}.`);
    }
    fs.writeFileSync(path.join(this.dir, folder, `${stem}.json`), `${JSON.stringify(file, null, 2)}\n`);
    if (!existing) this.writeOrder(folder, [...loops.map((l) => stemOf(l.id)), stem]);
    this.emit('change');
    return { id, name: file.name, folder, replaced: !!existing };
  }

  /** Move a loop to position `index` (0-based; the end if left out) of its own folder or another one. */
  move(id, folderName, index) {
    const loop = this.get(id);
    const folder = folderName == null ? loop.folder : this.requireFolder(folderName);
    let stem = stemOf(loop.id);
    if (folder !== loop.folder) {
      const target = this.freeStem(folder, stem);
      fs.renameSync(path.join(this.dir, loop.folder, `${stem}.json`), path.join(this.dir, folder, `${target}.json`));
      this.writeOrder(loop.folder, this.loops(loop.folder).map((l) => stemOf(l.id)));
      stem = target;
    }
    const order = this.loops(folder)
      .map((l) => stemOf(l.id))
      .filter((s) => s !== stem);
    const at = Number.isInteger(index) ? Math.min(Math.max(index, 0), order.length) : order.length;
    order.splice(at, 0, stem);
    this.writeOrder(folder, order);
    this.emit('change');
    return { id: `${folder}/${stem}`, from: loop.id, name: loop.name, folder, position: at + 1 };
  }

  readOrder(folder) {
    try {
      const order = JSON.parse(fs.readFileSync(path.join(this.dir, folder, ORDER_FILE), 'utf8'));
      return Array.isArray(order) ? order.map(String) : [];
    } catch {
      return [];
    }
  }

  writeOrder(folder, stems) {
    fs.writeFileSync(path.join(this.dir, folder, ORDER_FILE), `${JSON.stringify(stems, null, 2)}\n`);
  }

  freeStem(folder, base) {
    let stem = base;
    for (let n = 2; fs.existsSync(path.join(this.dir, folder, `${stem}.json`)); n++) stem = `${base}-${n}`;
    return stem;
  }
}
