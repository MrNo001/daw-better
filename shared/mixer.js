// The mixer, shared by the server (checking values, describing the mix to Claude) and the
// browser (the Mixer window and the audio graph in public/effects.js).
//
// Every track id has a mixer channel, shared by all the patterns that have a track with that
// id: the kick in every pattern goes through the "kick" channel. A channel has a fader in dB,
// panning, mute and solo, and a chain of effects that the sound runs through in order. Every
// channel then goes through the master channel, which has a fader and effects of its own.

import { INSTRUMENTS } from './instruments.js';
import { SYNTHS } from './synths.js';

export const MAX_EFFECTS = 8;
// Fader range in dB. The bottom of the fader is silence.
export const VOLUME_RANGE = [-60, 6];
export const PAN_RANGE = [-100, 100];

export const defaultChannel = () => ({ volume: 0, pan: 0, mute: false, solo: false, effects: [] });
export const defaultMaster = () => ({ volume: 0, effects: [] });

// Delay times follow the tempo: each is a note length, measured in beats.
export const DELAY_TIMES = [
  { id: '1/16', name: '1/16', beats: 0.25 },
  { id: '1/8t', name: '1/8 triplet', beats: 1 / 3 },
  { id: '1/8', name: '1/8', beats: 0.5 },
  { id: '1/8d', name: 'Dotted 1/8', beats: 0.75 },
  { id: '1/4', name: '1/4', beats: 1 },
  { id: '1/4d', name: 'Dotted 1/4', beats: 1.5 },
  { id: '1/2', name: '1/2', beats: 2 },
];

// The effects a channel can run. A setting is either a number with a range (`log` ones turn
// in proportion, like frequencies and times) or a choice between `options`. `doc` explains
// the setting to Claude; `about` explains the effect to the user, on its card in the Mixer.
const percent = (id, name, value, doc) => ({ id, name, min: 0, max: 100, default: value, step: 1, unit: '%', doc });
const decibels = (id, name, min, max, value, doc) => ({ id, name, min, max, default: value, step: 0.5, unit: 'dB', doc });

export const EFFECTS = [
  {
    id: 'eq',
    name: 'EQ',
    short: 'EQ',
    hint: 'tone',
    about: 'Shapes the tone: more or less bass (Low), body around Freq (Mid) and brightness (High).',
    params: [
      decibels('low', 'Low', -15, 15, 0, 'boost or cut of the bass, 120 Hz and below'),
      decibels('mid', 'Mid', -15, 15, 0, 'boost or cut around freq'),
      { id: 'freq', name: 'Freq', min: 200, max: 5000, default: 1000, log: true, unit: 'Hz', doc: 'center of the mid band' },
      decibels('high', 'High', -15, 15, 0, 'boost or cut of the treble, 7 kHz and above'),
    ],
  },
  {
    id: 'compressor',
    name: 'Compressor',
    short: 'Comp',
    hint: 'punch',
    about: 'Evens out the level: whatever goes over the Threshold is turned down by the Ratio. A slower Attack lets the hit through first, for punch.',
    params: [
      decibels('threshold', 'Threshold', -60, 0, -20, 'level where compression starts'),
      { id: 'ratio', name: 'Ratio', min: 1, max: 20, default: 4, log: true, unit: ':1', doc: '4 turns 4 dB over the threshold into 1; 20 limits' },
      { id: 'attack', name: 'Attack', min: 0.1, max: 100, default: 10, log: true, unit: 'ms', doc: 'how fast it reacts; 20-30 ms keeps the punch of drums' },
      { id: 'release', name: 'Release', min: 10, max: 1000, default: 150, log: true, unit: 'ms', doc: 'how fast it lets go' },
      decibels('gain', 'Gain', -12, 12, 0, 'output level; the compressor already makes up most of the level it takes away'),
    ],
  },
  {
    id: 'drive',
    name: 'Drive',
    short: 'Drive',
    hint: 'grit',
    about: 'Distortion: warm saturation, fuzz, or lo-fi bit crushing. Tone darkens it.',
    params: [
      { id: 'mode', name: 'Type', options: [['warm', 'Warm'], ['fuzz', 'Fuzz'], ['crush', 'Crush']], default: 'warm', doc: '"warm" (soft saturation), "fuzz" (hard clipping) or "crush" (lo-fi bit reduction)' },
      percent('amount', 'Amount', 35, 'how hard it distorts'),
      percent('tone', 'Tone', 60, '0 is dark, 100 is bright'),
      percent('mix', 'Mix', 100, 'how much of the effect you hear: 50 adds it on top of the dry sound, 100 is only the effect'),
    ],
  },
  {
    id: 'filter',
    name: 'Filter',
    short: 'Filter',
    hint: 'darker or thinner',
    about: 'Low-pass keeps what is below the Cutoff (darker, muffled); high-pass keeps what is above (thinner). Resonance adds a peak at the cutoff.',
    params: [
      { id: 'mode', name: 'Type', options: [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']], default: 'lowpass', doc: '"lowpass", "highpass" or "bandpass"' },
      { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 2000, log: true, unit: 'Hz', doc: 'cutoff frequency' },
      percent('resonance', 'Resonance', 20, 'peak at the cutoff; high values whistle'),
    ],
  },
  {
    id: 'delay',
    name: 'Delay',
    short: 'Delay',
    hint: 'echoes',
    about: 'Echoes in time with the tempo. Feedback sets how many repeats; Tone makes them darker.',
    params: [
      { id: 'time', name: 'Time', options: DELAY_TIMES.map((t) => [t.id, t.name]), default: '1/8d', doc: `echo spacing as a note length: ${DELAY_TIMES.map((t) => `"${t.id}"`).join(', ')} (t = triplet, d = dotted)` },
      { id: 'mode', name: 'Stereo', options: [['mono', 'Mono'], ['pingpong', 'Ping-pong']], default: 'pingpong', doc: '"mono", or "pingpong" to bounce the echoes left and right' },
      { id: 'feedback', name: 'Feedback', min: 0, max: 90, default: 35, step: 1, unit: '%', doc: 'how much each echo repeats' },
      percent('tone', 'Tone', 60, '0 is dark, 100 is bright'),
      percent('mix', 'Mix', 30, 'how much of the effect you hear: 50 adds it on top of the dry sound, 100 is only the effect'),
    ],
  },
  {
    id: 'reverb',
    name: 'Reverb',
    short: 'Verb',
    hint: 'space',
    about: 'The room around the sound, from a small room to a huge hall. Decay is how long it rings out.',
    params: [
      { id: 'decay', name: 'Decay', min: 0.2, max: 8, default: 1.5, log: true, unit: 's', doc: 'seconds the reverb takes to die away: 0.5 a small room, 2 a hall, 5 a cathedral' },
      percent('tone', 'Tone', 50, '0 is dark, 100 is bright'),
      percent('mix', 'Mix', 25, 'how much of the effect you hear: 50 adds it on top of the dry sound, 100 is only the effect'),
    ],
  },
  {
    id: 'chorus',
    name: 'Chorus',
    short: 'Chorus',
    hint: 'width',
    about: 'Thickens and widens the sound with slowly drifting copies, like several players at once.',
    params: [
      { id: 'rate', name: 'Rate', min: 0.1, max: 5, default: 0.8, log: true, unit: 'Hz', doc: 'speed of the drift' },
      percent('depth', 'Depth', 50, 'how far the copies drift'),
      percent('mix', 'Mix', 50, 'how much of the effect you hear: 50 adds it on top of the dry sound, 100 is only the effect'),
    ],
  },
];

const byId = new Map(EFFECTS.map((e) => [e.id, e]));
export const effectType = (id) => byId.get(id) ?? null;
export const effectList = () => EFFECTS.map((e) => e.id).join(', ');

export const defaultParams = (type) => Object.fromEntries(effectType(type).params.map((p) => [p.id, p.default]));

// Three significant digits, for settings that turn in proportion (1250 Hz, 0.85 s).
const significant = (v) => Number(v.toPrecision(3));

/** A setting's value, clamped and rounded; throws for a choice that isn't one of the options. */
export function checkParam(param, value) {
  if (param.options) {
    const option = param.options.find(([id, name]) => id === value || name.toLowerCase() === String(value).toLowerCase());
    if (!option) throw new Error(`${param.name} is one of ${param.options.map(([id]) => `"${id}"`).join(', ')}.`);
    return option[0];
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${param.name} must be a number.`);
  const clamped = Math.min(param.max, Math.max(param.min, n));
  return param.step ? Math.round(clamped / param.step) * param.step : significant(clamped);
}

// Knob position (0-1) and value, so log settings spread evenly over the knob.
export function toPosition(param, value) {
  return param.log ? Math.log(value / param.min) / Math.log(param.max / param.min) : (value - param.min) / (param.max - param.min);
}
export function fromPosition(param, position) {
  const p = Math.min(1, Math.max(0, position));
  return checkParam(param, param.log ? param.min * (param.max / param.min) ** p : param.min + p * (param.max - param.min));
}

export function formatParam(param, value) {
  if (param.options) return param.options.find(([id]) => id === value)?.[1] ?? String(value);
  switch (param.unit) {
    case 'dB':
      return `${value > 0 ? '+' : ''}${value} dB`;
    case 'Hz':
      return value >= 1000 ? `${significant(value / 1000)} kHz` : `${Math.round(value)} Hz`;
    case ':1':
      return `${significant(value)}:1`;
    case '%':
      return `${value}%`;
    default:
      return `${value} ${param.unit}`;
  }
}

/**
 * "Reverb (decay 1.5 s, tone 50%, mix 25%)", or "Reverb (off; ...)" when it's bypassed. Choices
 * show their ids and frequencies stay in Hz, the way Claude's set_mixer takes them.
 */
export function describeEffect(effect) {
  const type = effectType(effect.type);
  const value = (p, v) => (p.options ? v : p.unit === 'Hz' ? `${v} Hz` : formatParam(p, v));
  const settings = type.params.map((p) => `${p.id} ${value(p, effect.params[p.id])}`).join(', ');
  return `${type.name} (${effect.on ? '' : 'off; '}${settings})`;
}

export const formatDb = (db) => (db <= VOLUME_RANGE[0] ? '-inf dB' : `${db > 0 ? '+' : ''}${+db.toFixed(1)} dB`);
export const formatPan = (pan) => (pan === 0 ? 'center' : `${Math.abs(pan)}% ${pan < 0 ? 'left' : 'right'}`);
export const dbToGain = (db) => (db <= VOLUME_RANGE[0] ? 0 : 10 ** (db / 20));

/**
 * The mixer's channels in order: every drum track id across the patterns, then every synth
 * track id, each named as in the current pattern if it has that track. `here` is false for a
 * channel whose track only appears in other patterns.
 */
export function mixerChannels(state) {
  const current = state.patterns.find((p) => p.id === state.current) ?? state.patterns[0];
  const found = new Map();
  const visit = (track, kind) => {
    const sound = kind === 'drum' ? INSTRUMENTS.find((i) => i.id === track.instrument) : SYNTHS.find((s) => s.id === track.preset);
    if (!found.has(track.id)) found.set(track.id, { id: track.id, kind, name: track.name, sound: sound?.id, color: sound?.color ?? '#8d95a7', here: false });
  };
  for (const track of [...current.tracks]) visit(track, 'drum');
  for (const track of [...current.synths]) visit(track, 'synth');
  for (const c of found.values()) c.here = true;
  const others = state.patterns.filter((p) => p !== current);
  for (const p of others) for (const t of p.tracks) visit(t, 'drum');
  for (const p of others) for (const s of p.synths) visit(s, 'synth');
  // Stable order: drums before synths, each in order of first appearance across the patterns.
  const order = [];
  for (const kind of ['drum', 'synth']) {
    for (const p of state.patterns) {
      for (const t of kind === 'drum' ? p.tracks : p.synths) if (!order.includes(t.id) && found.get(t.id).kind === kind) order.push(t.id);
    }
  }
  return order.map((id) => found.get(id));
}
