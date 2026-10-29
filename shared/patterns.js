// Patterns and the song arrangement, shared by the server and the browser.

// The Playlist counts in 4/4: a bar line every 4 beats.
export const BEATS_PER_BAR = 4;

// Clip colors in the Playlist. A pattern stores an index into this list.
export const PATTERN_COLORS = ['#f5a524', '#4dabf7', '#63e6be', '#f783ac', '#b197fc', '#ffd43b', '#ff8787', '#3bc9db'];

/** A pattern's length in whole beats: how long a new clip of it lasts. */
export const patternBeats = (pattern) => Math.max(1, Math.ceil(pattern.length / pattern.stepsPerBeat));

/** "bar 3", or "bar 3 beat 2" off the bar line, for a position in beats from the start of the song. */
export function barLabel(beat) {
  const bar = Math.floor(beat / BEATS_PER_BAR) + 1;
  const rest = beat % BEATS_PER_BAR;
  return rest ? `bar ${bar} beat ${+(rest + 1).toFixed(2)}` : `bar ${bar}`;
}

/** "2 bars", "1 bar" or "6 beats". */
export function lengthLabel(beats) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return beats % BEATS_PER_BAR === 0 ? plural(beats / BEATS_PER_BAR, 'bar') : plural(+beats.toFixed(2), 'beat');
}
