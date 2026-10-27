import { PITCH_RANGE, noteName, parsePitch } from '../shared/synths.js';

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

export function formatGrid(state) {
  const { bpm, swing, length, stepsPerBeat: spb, playing, tracks, synths } = state;
  const beats = +(length / spb).toFixed(2);
  const lines = [
    `${playing ? 'PLAYING' : 'STOPPED'} · ${bpm} BPM · swing ${swing}% · ` +
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
