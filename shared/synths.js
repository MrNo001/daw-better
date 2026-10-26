// Melodic synth sounds for the piano roll, plus note-name helpers. Imported by both the
// server and the browser.

import { normalizeName } from './instruments.js';

export const SYNTHS = [
  { id: 'bass', name: 'Bass', color: '#f06595' },
  { id: 'keys', name: 'Keys', color: '#74c0fc' },
  { id: 'lead', name: 'Lead', color: '#ffd43b' },
  { id: 'pad', name: 'Pad', color: '#b197fc' },
  { id: 'pluck', name: 'Pluck', color: '#63e6be' },
];

// The piano roll spans C1 to C7 (MIDI 24-96).
export const PITCH_RANGE = [24, 96];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTERS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** MIDI number to scientific pitch notation: 60 -> "C4" (middle C). */
export function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** "C4", "F#2", "Bb3" or a MIDI number -> MIDI number, or null if it can't be read. */
export function parsePitch(value) {
  if (Number.isInteger(value)) return value;
  const match = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(String(value).trim());
  if (!match) return null;
  const accidental = { '#': 1, '♯': 1, b: -1, '♭': -1 }[match[2]] ?? 0;
  return LETTERS[match[1].toLowerCase()] + accidental + (Number(match[3]) + 1) * 12;
}

export function resolveSynth(name) {
  const key = normalizeName(name);
  return SYNTHS.find((s) => s.id === key || normalizeName(s.name) === key) ?? null;
}
