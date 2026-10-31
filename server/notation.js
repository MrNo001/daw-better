import { PITCH_RANGE, noteName, parsePitch } from '../shared/synths.js';
import { BEATS_PER_BAR, barLabel, lengthLabel } from '../shared/patterns.js';
import { defaultChannel, describeEffect, formatDb, formatPan, mixerChannels } from '../shared/mixer.js';

// Text notation used by the MCP tools: one character per step.
//   X = accent (1.0)   x = hit (0.8)   o = ghost note (0.45)   . or - = rest   1-9 = velocity n/9
// Spaces and | are ignored, so "x... x... | x... x..." is fine.

const SYMBOLS = { X: 1, x: 0.8, o: 0.45, O: 0.45, g: 0.45, '.': 0, '-': 0, _: 0, 0: 0 };

const SUBDIVISIONS = {
  1: 'quarter notes',
  2: '8th notes',
  3: '8th-note triplets',
  4: '16th notes',
  6: '16th-note triplets',
  8: '32nd notes',
};

export function parseSteps(text, length) {
  const chars = [...String(text).replace(/[\s|]/g, '')];
  if (chars.length === 0) throw new Error('Step string is empty; use "." for rests.');
  if (chars.length > length) {
    throw new Error(
      `"${text}" has ${chars.length} steps but the pattern is ${length} steps long. ` +
        'Shorten it, or change the length with set_transport first.',
    );
  }
  const values = chars.map((c) => {
    if (c in SYMBOLS) return SYMBOLS[c];
    if (/[1-9]/.test(c)) return Number(c) / 9;
    throw new Error(`Unknown step symbol "${c}" in "${text}". Use X x o . or digits 1-9.`);
  });
  // Shorter strings repeat to fill the pattern.
  return Array.from({ length }, (_, i) => values[i % values.length]);
}

export function stepChar(velocity) {
  if (velocity <= 0) return '.';
  if (velocity >= 0.9) return 'X';
  if (velocity >= 0.6) return 'x';
  return 'o';
}

// The symbols stand for exact velocities; with `exact`, any other velocity is written as a
// digit 1-9 instead of the nearest symbol, so a saved loop file keeps it.
function exactChar(velocity) {
  if (velocity <= 0) return '.';
  return { 1: 'X', 0.8: 'x', 0.45: 'o' }[velocity] ?? String(Math.min(9, Math.max(1, Math.round(velocity * 9))));
}

export function formatSteps(steps, stepsPerBeat, exact = false) {
  return steps.map((v, i) => (i > 0 && i % stepsPerBeat === 0 ? ' ' : '') + (exact ? exactChar(v) : stepChar(v))).join('');
}

// Synth notes as "pitch@step+length", e.g. "A2@1+2" is an A2 on step 1 lasting two steps.
// Velocity is only shown when it isn't the default 0.8.
export function formatNotes(notes) {
  return notes
    .map((n) => `${noteName(n.pitch)}@${n.start + 1}+${n.length}${n.velocity === 0.8 ? '' : `(v${+n.velocity.toFixed(2)})`}`)
    .join(' ');
}

// Reads notes written by formatNotes, as used in loop files: "A2@1+2 C3@7+2(v1)". Steps start
// at 1, the length defaults to 1 and the velocity to 0.8. Returns 0-based starts.
export function parseNotes(text, length) {
  return String(text)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const match = /^([^@]+)@(\d+)(?:\+(\d+))?(?:\(v([\d.]+)\))?$/.exec(token);
      if (!match) throw new Error(`can't read the note "${token}"; write notes like "A2@1+2"`);
      const pitch = parsePitch(match[1]);
      if (pitch === null || pitch < PITCH_RANGE[0] || pitch > PITCH_RANGE[1]) throw new Error(`"${match[1]}" isn't a note between C1 and C7`);
      const start = Number(match[2]) - 1;
      if (start < 0 || start >= length) throw new Error(`the note "${token}" starts outside the ${length} steps`);
      const velocity = match[4] === undefined ? 0.8 : Number(match[4]);
      if (!(velocity >= 0 && velocity <= 1)) throw new Error(`the velocity in "${token}" must be between 0 and 1`);
      return { pitch, start, length: Math.max(1, Math.min(Number(match[3] ?? 1), length - start)), velocity };
    });
}

const currentPattern = (state) => state.patterns.find((p) => p.id === state.current) ?? state.patterns[0];

// The current pattern as a text grid, the way Claude sees what the sequencer and piano roll show.
export function formatGrid(state) {
  const pattern = currentPattern(state);
  const { length, stepsPerBeat: spb, swing, tracks, synths } = pattern;
  const beats = +(length / spb).toFixed(2);
  const position = state.patterns.length > 1 ? `, ${state.patterns.indexOf(pattern) + 1} of ${state.patterns.length}` : '';
  const lines = [
    `${state.playing ? 'PLAYING' : 'STOPPED'} · ` +
      `${state.mode === 'song' ? 'song mode (Play plays the arrangement)' : 'pattern mode (Play loops the current pattern)'} · ${state.bpm} BPM`,
    `Current pattern "${pattern.name}" (${pattern.id}${position}): swing ${swing}% · ` +
      `${length} steps at ${spb} per beat (${SUBDIVISIONS[spb] ?? 'custom subdivision'}) = ${beats} beats`,
    '',
  ];

  const labelWidth = Math.max(10, ...tracks.map((t) => t.id.length), ...synths.map((s) => s.id.length)) + 1;
  if (spb > 1) {
    let ruler = '';
    for (let b = 0; b * spb < length; b++) ruler += String(b + 1).padEnd(spb + 1);
    lines.push(`${'beat'.padEnd(labelWidth)}  ${ruler.trimEnd()}`);
  }

  const anySolo = [...tracks, ...synths].some((t) => t.solo);
  const flags = (t, sound) => {
    const info = [`vol ${Math.round(t.volume * 100)}%`];
    if (t.id !== sound) info.push(`sound: ${sound}`);
    if (t.mute) info.push('MUTED');
    if (t.solo) info.push('SOLO');
    else if (anySolo) info.push('silent (another track is soloed)');
    return info.join(', ');
  };
  for (const t of tracks) lines.push(`${t.id.padEnd(labelWidth)}| ${formatSteps(t.steps, spb)} |  ${flags(t, t.instrument)}`);
  if (tracks.length === 0) lines.push('(no drum tracks)');

  if (synths.length) {
    lines.push('', 'Synth tracks (piano roll), notes as pitch@step+length:');
    for (const s of synths) lines.push(`${s.id.padEnd(labelWidth)}| ${formatNotes(s.notes) || '(no notes)'}  [${flags(s, s.preset)}]`);
  }
  return lines.join('\n');
}

// Every pattern and the song arrangement, lane by lane.
export function formatSong(state) {
  const names = new Map(state.patterns.map((p) => [p.id, p.name]));
  const lines = [
    'Patterns: ' +
      state.patterns
        .map((p) => `"${p.name}" (${p.id}, ${lengthLabel(p.length / p.stepsPerBeat)}${p.id === state.current ? ', current' : ''})`)
        .join(', '),
  ];
  if (state.arrangement.length === 0) {
    lines.push('Arrangement: empty.');
    return lines.join('\n');
  }
  const end = Math.max(...state.arrangement.map((c) => c.start + c.length));
  lines.push(`Arrangement, ${lengthLabel(Math.ceil(end / BEATS_PER_BAR) * BEATS_PER_BAR)} in 4/4 (a clip longer than its pattern repeats it):`);
  for (const lane of [...new Set(state.arrangement.map((c) => c.lane))].sort((a, b) => a - b)) {
    const clips = state.arrangement.filter((c) => c.lane === lane);
    lines.push(`- lane ${lane + 1}: ${clips.map((c) => `"${names.get(c.pattern)}" at ${barLabel(c.start)} for ${lengthLabel(c.length)}`).join('; ')}`);
  }
  return lines.join('\n');
}

// The mixer, channel by channel. Channels nobody has touched are listed together at the end.
export function formatMixer(state) {
  const channels = mixerChannels(state);
  const settings = (id) => state.mixer.channels[id] ?? defaultChannel();
  const soloed = channels.filter((c) => settings(c.id).solo).map((c) => c.id);
  const effects = (list) => (list.length ? list.map(describeEffect).join(' → ') : 'no effects');
  const lines = ['Mixer, shared by every pattern (faders in dB, 0 dB leaves the level as it is; effects run left to right):'];
  if (soloed.length) lines.push(`- SOLO: only ${soloed.join(', ')} can be heard`);
  const untouched = [];
  for (const c of channels) {
    const s = settings(c.id);
    const info = [];
    if (s.mute) info.push('MUTED');
    if (s.solo) info.push('SOLO');
    if (s.volume !== 0 || s.pan !== 0 || s.effects.length) info.push(formatDb(s.volume), formatPan(s.pan), effects(s.effects));
    const label = `${c.id}${c.name.toLowerCase() === c.id.replace(/_/g, ' ') ? '' : ` ("${c.name}")`}${c.here ? '' : ', not in this pattern'}`;
    if (info.length) lines.push(`- ${label}: ${info.join(', ')}`);
    else untouched.push(c.id);
  }
  if (untouched.length) lines.push(`- at 0 dB, centered, no effects: ${untouched.join(', ')}`);
  lines.push(`- master: ${formatDb(state.mixer.master.volume)}, ${effects(state.mixer.master.effects)}`);
  return lines.join('\n');
}
