// Instruments the browser synth can play. Imported by both the server and the browser.

export const INSTRUMENTS = [
  { id: 'kick', name: 'Kick', color: '#ff6b6b' },
  { id: 'snare', name: 'Snare', color: '#ffa94d' },
  { id: 'clap', name: 'Clap', color: '#ffd43b' },
  { id: 'rim', name: 'Rim', color: '#a9e34b' },
  { id: 'closed_hat', name: 'Closed Hat', color: '#3bc9db' },
  { id: 'open_hat', name: 'Open Hat', color: '#4dabf7' },
  { id: 'low_tom', name: 'Low Tom', color: '#9775fa' },
  { id: 'mid_tom', name: 'Mid Tom', color: '#b197fc' },
  { id: 'high_tom', name: 'High Tom', color: '#d0bfff' },
  { id: 'cowbell', name: 'Cowbell', color: '#f783ac' },
  { id: 'crash', name: 'Crash', color: '#ced4da' },
];

export const DEFAULT_KIT = ['kick', 'snare', 'clap', 'rim', 'closed_hat', 'open_hat', 'low_tom', 'high_tom'];

// Common shorthand people (and Claude) use for drum names.
const ALIASES = {
  bd: 'kick', bass_drum: 'kick', bassdrum: 'kick',
  sd: 'snare', snare_drum: 'snare',
  cp: 'clap', hand_clap: 'clap', handclap: 'clap',
  rs: 'rim', rimshot: 'rim', rim_shot: 'rim',
  hh: 'closed_hat', ch: 'closed_hat', hat: 'closed_hat', hihat: 'closed_hat', hi_hat: 'closed_hat',
  closed_hihat: 'closed_hat', closed_hi_hat: 'closed_hat',
  oh: 'open_hat', open_hihat: 'open_hat', open_hi_hat: 'open_hat',
  lt: 'low_tom', floor_tom: 'low_tom', mt: 'mid_tom', tom: 'mid_tom', ht: 'high_tom',
  cb: 'cowbell', cy: 'crash', cymbal: 'crash', crash_cymbal: 'crash',
};

export function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function resolveInstrument(name) {
  const key = normalizeName(name);
  const id = ALIASES[key] ?? key;
  return INSTRUMENTS.find((i) => i.id === id) ?? null;
}
