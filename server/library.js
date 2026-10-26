// The loop library: genre folders of ready-made patterns, stored as JSON files under
// library/<Genre>/<loop>.json. The folders are read on every request, so loops added by
// hand show up without restarting the server.
//
// A loop file looks like:
//   {
//     "name": "Four on the Floor",
//     "description": "What to listen for.",
//     "bpm": 120, "swing": 50, "stepsPerBeat": 4, "length": 16,
//     "tracks": {
//       "kick": "x... x... x... x...",
//       "Ghost Snare": { "instrument": "snare", "steps": ".o.. ...o", "volume": 0.5 }
//     }
//   }
// Tracks use the same step notation as the MCP tools (see notation.js).

import fs from 'node:fs';
import path from 'node:path';
import { resolveInstrument } from '../shared/instruments.js';
import { parseSteps } from './notation.js';
import { LIMITS } from './operations.js';

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

function normalizeLoop(id, raw) {
  const length = Math.round(number(raw.length, LIMITS.length, 16));
  const tracks = Object.entries(raw.tracks ?? {}).map(([key, spec]) => {
    const def = typeof spec === 'string' ? { steps: spec } : spec;
    const inst = resolveInstrument(def.instrument ?? key);
    if (!inst) throw new Error(`unknown instrument "${def.instrument ?? key}"`);
    return {
      name: def.name ?? (resolveInstrument(key) ? inst.name : key),
      instrument: inst.id,
      volume: number(def.volume, [0, 1], 0.8),
      steps: parseSteps(def.steps, length),
    };
  });
  if (tracks.length === 0) throw new Error('it has no tracks');
  if (tracks.length > LIMITS.tracks) throw new Error(`it has more than ${LIMITS.tracks} tracks`);

  const [folder, file] = id.split('/');
  return {
    id,
    folder,
    name: typeof raw.name === 'string' ? raw.name : file,
    description: typeof raw.description === 'string' ? raw.description : '',
    bpm: Math.round(number(raw.bpm, LIMITS.bpm, 100)),
    swing: Math.round(number(raw.swing, LIMITS.swing, 50)),
    stepsPerBeat: Math.round(number(raw.stepsPerBeat, LIMITS.stepsPerBeat, 4)),
    length,
    tracks,
  };
}

export class Library {
  constructor(dir) {
    this.dir = dir;
  }

  /** Every folder with its loops, sorted by name. Broken files are skipped with a warning. */
  list() {
    const folders = [];
    for (const folder of readDir(this.dir)) {
      if (!folder.isDirectory()) continue;
      const loops = [];
      for (const file of readDir(path.join(this.dir, folder.name))) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const id = `${folder.name}/${file.name.slice(0, -'.json'.length)}`;
        try {
          loops.push(normalizeLoop(id, JSON.parse(fs.readFileSync(path.join(this.dir, folder.name, file.name), 'utf8'))));
        } catch (err) {
          console.warn(`Skipping loop ${id}: ${err.message}`);
        }
      }
      loops.sort((a, b) => a.name.localeCompare(b.name));
      folders.push({ name: folder.name, loops });
    }
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Look a loop up by id ("Rock/basic-rock-beat"), ignoring case. Only listed loops can be loaded. */
  get(id) {
    const key = String(id).trim().toLowerCase();
    const loop = this.list()
      .flatMap((f) => f.loops)
      .find((l) => l.id.toLowerCase() === key);
    if (!loop) throw new Error(`There is no loop "${id}" in the library. Use list_loops to see what's there.`);
    return loop;
  }
}
