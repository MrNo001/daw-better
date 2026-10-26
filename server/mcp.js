// MCP tools that let Claude read and edit the sequencer. A fresh McpServer is created for
// each HTTP request (stateless mode); all state lives in the shared Store.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { INSTRUMENTS } from '../shared/instruments.js';
import { formatGrid } from './notation.js';
import * as ops from './operations.js';

const INSTRUCTIONS = `daw-better is a drum sequencer open in the user's browser. Every change you make with these tools appears in the grid immediately and is heard live if the pattern is playing. People use it to experiment with rhythm and to learn it.

- Call get_state before editing if you haven't looked recently: the user edits the grid by hand too, and their recent edits are listed there.
- Steps are numbered from 1. With 4 steps per beat, a 16-step bar has beats on steps 1, 5, 9 and 13.
- set_pattern writes whole tracks in one undoable step; set_steps is for small tweaks.
- The loop library (list_loops, load_loop) holds ready-made grooves in genre folders. The user browses the same library in the app's Browser window, and a library loop makes a good starting point to study or vary.
- When teaching, build a groove up in layers and start playback so the user hears each one. Use show_note to say what to listen for, highlighting the steps you mean, and keep notes short since the grid is the main thing. Invite the user to try a variation by hand, then read it back with get_state and respond to what they did.
- Everything can be undone, so experiment freely.`;

const trackRef = z.string().describe('Track id, track name, or instrument (e.g. "kick", "hh", "Open Hat")');
const stepNumber = z.number().int().min(1).describe('Step number, starting at 1');

function ago(timestamp) {
  const s = Math.round((Date.now() - timestamp) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

export function createMcpServer({ store, library, audience, appUrl }) {
  const server = new McpServer({ name: 'daw-better', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const listening = () => {
    const { clients, audioReady } = audience();
    if (clients === 0) return `\n\nNote: the app isn't open in any browser, so nothing can be heard. Ask the user to open ${appUrl}.`;
    if (store.state.playing && audioReady === 0) {
      return "\n\nNote: the browser hasn't enabled audio yet. Ask the user to click anywhere on the daw-better page once.";
    }
    return '';
  };

  const text = (body) => ({ content: [{ type: 'text', text: body }] });

  // Registers a tool whose handler edits the state and returns a summary; the reply
  // always ends with the updated grid so Claude can check the result.
  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        const summary = handler(args);
        return text(`${summary}\n\n${formatGrid(store.state)}${listening()}`);
      } catch (err) {
        return { ...text(err.message), isError: true };
      }
    });

  const edit = (fn, options) => store.change('claude', fn, options);

  server.registerTool(
    'get_state',
    {
      title: 'Read the sequencer',
      description:
        "Read what's in the sequencer right now: transport, every track's steps as a text grid " +
        '(X accent, x hit, o ghost note, . rest), the note on screen, and what the user changed recently.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { note, loop } = store.state;
      const recent = store.activity
        .slice(0, 10)
        .map((a) => `- ${ago(a.at)}, ${a.source === 'claude' ? 'you' : 'the user'}: ${a.text}`)
        .join('\n');
      return text(
        [
          formatGrid(store.state),
          loop ? `Started from library loop ${loop.id} ("${loop.name}"), possibly edited since.` : 'Not based on a library loop.',
          note ? `On-screen note: "${note.title || note.body.slice(0, 60)}"` : 'No note on screen.',
          `Recent changes, newest first:\n${recent || '(none yet)'}`,
          `Instruments: ${INSTRUMENTS.map((i) => i.id).join(', ')}`,
        ].join('\n\n') + listening(),
      );
    },
  );

  server.registerTool(
    'list_loops',
    {
      title: 'Browse the loop library',
      description: 'List the ready-made loops in the library, grouped in genre folders, with tempo and a short description. Load one with load_loop.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const folders = library.list();
      if (folders.length === 0) return text('The library is empty.');
      return text(
        folders
          .map(
            (f) =>
              `${f.name}\n` +
              f.loops
                .map((l) => `- ${l.id}: "${l.name}", ${l.bpm} BPM${l.swing > 50 ? `, swing ${l.swing}%` : ''}. ${l.description}`)
                .join('\n'),
          )
          .join('\n\n'),
      );
    },
  );

  tool(
    'load_loop',
    {
      title: 'Load a library loop',
      description:
        "Replace the current pattern (tempo, swing, length and tracks) with a loop from the library. The user can undo it, but say what you're loading first if they've been working on something.",
      inputSchema: { id: z.string().describe('Loop id from list_loops, e.g. "Rock/basic-rock-beat"') },
    },
    ({ id }) => edit((s) => ops.loadLoop(s, library.get(id))),
  );

  tool(
    'set_pattern',
    {
      title: 'Write tracks',
      description:
        'Write whole tracks from step strings, one character per step: X accent, x hit, o ghost note, . rest ' +
        '(digits 1-9 give an exact velocity). Spaces and | are ignored, so group by beat: "x... x... x... x...". ' +
        'A string shorter than the pattern repeats to fill it: "x." hits every other step, and "x.." over 16 steps ' +
        'makes a 3-against-4 polyrhythm. Naming an instrument with no track yet adds one. ' +
        'All tracks in one call become a single undo step.',
      inputSchema: {
        tracks: z
          .record(z.string(), z.string())
          .describe('Track reference mapped to its step string, e.g. {"kick": "x... .... x... ....", "snare": ".... x... .... x..."}'),
        clear_others: z.boolean().optional().describe('Silence every track not listed. Default false.'),
      },
    },
    ({ tracks, clear_others }) => edit((s) => ops.setPattern(s, { tracks, clearOthers: clear_others })),
  );

  tool(
    'set_steps',
    {
      title: 'Edit steps',
      description: 'Turn individual steps on one track on or off, or change their velocity, without touching the rest.',
      inputSchema: {
        track: trackRef,
        steps: z
          .array(
            z.object({
              step: stepNumber,
              velocity: z.number().min(0).max(1).describe('0 = off, 0.45 ghost, 0.8 normal hit, 1 accent'),
            }),
          )
          .min(1),
      },
    },
    ({ track, steps }) =>
      edit((s) => ops.setSteps(s, { track, steps: steps.map((x) => ({ step: x.step - 1, velocity: x.velocity })) })),
  );

  tool(
    'set_transport',
    {
      title: 'Tempo, length and playback',
      description:
        'Set tempo, swing, pattern length or subdivision, and start or stop playback. ' +
        'Swing runs from 50 (straight) to 75; 66 is a triplet shuffle and only affects even subdivisions. ' +
        'steps_per_beat sets what one step is: 4 = 16th notes, 2 = 8th notes, 3 = 8th-note triplets ' +
        '(length 12 is one bar of 12/8). Changing length keeps existing steps and pads with rests.',
      inputSchema: {
        bpm: z.number().min(30).max(300).optional(),
        swing: z.number().min(50).max(75).optional(),
        length: z.number().int().min(1).max(64).optional().describe('Number of steps in the loop'),
        steps_per_beat: z.number().int().min(1).max(8).optional(),
        playing: z.boolean().optional().describe('true to start playback, false to stop'),
      },
    },
    ({ bpm, swing, length, steps_per_beat, playing }) => {
      const done = [];
      if ([bpm, swing, length, steps_per_beat].some((v) => v !== undefined)) {
        done.push(edit((s) => ops.setTransport(s, { bpm, swing, length, stepsPerBeat: steps_per_beat })));
      }
      if (playing !== undefined) done.push(edit((s) => ops.setPlaying(s, { playing }), { undoable: false }));
      if (done.length === 0) throw new Error('Nothing to change.');
      return done.join('; ');
    },
  );

  tool(
    'set_track',
    {
      title: 'Track settings',
      description: "Change a track's volume, mute, solo, display name or instrument sound.",
      inputSchema: {
        track: trackRef,
        volume: z.number().min(0).max(1).optional(),
        mute: z.boolean().optional(),
        solo: z.boolean().optional(),
        name: z.string().optional(),
        instrument: z.string().optional().describe(`One of: ${INSTRUMENTS.map((i) => i.id).join(', ')}`),
      },
    },
    (args) => edit((s) => ops.setTrack(s, args)),
  );

  tool(
    'add_track',
    {
      title: 'Add a track',
      description: 'Add a new track for an instrument (at most 16 tracks).',
      inputSchema: {
        instrument: z.enum(INSTRUMENTS.map((i) => i.id)),
        name: z.string().optional().describe('Display name, e.g. "Ghost snare". Defaults to the instrument name.'),
      },
    },
    (args) => edit((s) => ops.addTrack(s, args)),
  );

  tool(
    'remove_track',
    {
      title: 'Remove a track',
      description: 'Delete a track and its steps.',
      inputSchema: { track: trackRef },
      annotations: { destructiveHint: true },
    },
    (args) => edit((s) => ops.removeTrack(s, args)),
  );

  tool(
    'clear',
    {
      title: 'Clear steps',
      description: 'Silence every step on the listed tracks, or on all tracks if none are given. The tracks stay.',
      inputSchema: { tracks: z.array(trackRef).optional() },
      annotations: { destructiveHint: true },
    },
    (args) => edit((s) => ops.clearTracks(s, args)),
  );

  tool(
    'show_note',
    {
      title: 'Show a note on screen',
      description:
        "Show a short explanation beside the grid on the user's screen, optionally highlighting the steps " +
        "you're talking about. Use it when teaching to say what to listen for. Supports **bold**, `code` and " +
        '"- " bullet lines. An empty body removes the note.',
      inputSchema: {
        title: z.string().optional(),
        body: z.string(),
        highlights: z.array(z.object({ track: trackRef, steps: z.array(stepNumber) })).optional(),
      },
    },
    ({ title, body, highlights }) =>
      edit(
        (s) =>
          ops.setNote(s, {
            title,
            body,
            highlights: highlights?.map((h) => ({ track: h.track, steps: h.steps.map((n) => n - 1) })),
          }),
        { undoable: false },
      ),
  );

  tool(
    'undo',
    {
      title: 'Undo',
      description: 'Undo the most recent changes to the pattern, whether you or the user made them.',
      inputSchema: { count: z.number().int().min(1).max(50).optional().describe('How many changes to undo. Default 1.') },
    },
    ({ count = 1 }) => `undid ${store.undo('claude', count)} change(s)`,
  );

  return server;
}
