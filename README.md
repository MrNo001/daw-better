# daw-better

A self-hosted drum sequencer and piano roll for experimenting with music and teaching it, with Claude connected over MCP. You and Claude edit the same pattern: anything Claude writes appears on screen right away and is heard live while it plays, and Claude can read back what you changed by hand.

This is the start of a larger DAW project built around experimenting with music and learning it with AI.

## Quick start

```sh
npm install
npm start          # or: npm run dev  (restarts on server changes)
```

Open http://localhost:3030 and click once anywhere to turn on audio (browsers require a click before playing sound).

### Connect Claude

**Claude Code, in this folder:** run `claude`. The bundled [.mcp.json](.mcp.json) registers the server, and Claude Code asks you to approve it the first time. Check with `/mcp`.

**Claude Code, from any folder:**

```sh
claude mcp add --scope user --transport http daw-better http://127.0.0.1:3030/mcp
```

**Claude Desktop:** its config file launches local commands, so bridge to the HTTP endpoint with the community [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package:

```json
{
  "mcpServers": {
    "daw-better": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3030/mcp"] }
  }
}
```

The daw-better server has to be running for Claude to reach it. The Claude card in the app shows when Claude last connected.

Things to try:

- "Teach me a bossa nova beat, one layer at a time."
- "I just changed the hi-hats. What did that do to the feel?"
- "Make this swing like a J Dilla beat."
- "Quiz me: write a famous drum pattern and let me guess it."
- "Build up a funk groove with me and save each stage in a folder called Funk Lesson."

## Using the sequencer

- Left-click a step to toggle it, or left-drag to paint steps on. Right-click erases a step, and right-drag erases everything it passes over. One drag is one undo step.
- <kbd>Shift</kbd>-click for an accent, <kbd>Alt</kbd>-click for a ghost note.
- Press a track's name button to hear its sound. The green light mutes the track, **S** solos it, and the knob sets its volume (drag up or down, double-click to reset).
- <kbd>Space</kbd> plays and stops. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redoes.
- **Tempo** and **Steps** in the display: drag up or down to change them, or click to type.
- **Grid** sets the subdivision: 16ths, 8ths, triplets, and so on. The counting row above the steps follows it ("1 e + a").
- **Swing** runs from 50% (straight) to 75%. 66% is a triplet shuffle.
- The sequencer, Piano Roll, Browser and Claude panels are windows. Drag them by the title bar, and double-click a title bar to collapse it. Resize the Piano Roll from its bottom-right corner. This browser remembers where you put them. On narrow screens they stack.

## Piano roll

Synth tracks play bass lines, melodies and chords. They share the drums' tempo, swing and step grid, so everything loops together.

- Each synth track has a tab. **+ Synth** adds one with a sound: Bass, Keys, Lead, Pad or Pluck. The green light mutes the selected track, **S** solos it, and the knob sets its volume.
- Left-click an empty spot to add a note, and drag a note to move it. Drag a note's right edge to change its length; new notes take the length you used last.
- Right-click deletes a note, and right-drag deletes every note it passes over.
- <kbd>Shift</kbd>-click a note to toggle an accent, <kbd>Alt</kbd>-click to toggle a soft note. Click a key on the keyboard to hear the pitch.
- The other synth tracks show faintly behind the selected one, so you can line parts up. When Claude writes notes, the roll switches to that track and the new notes flash.

The pattern is saved to `data/state.json` and restored when the server restarts. Set `DATA_FILE` to save somewhere else, for example to run separate instances side by side with different `PORT`s.

## Loop library

The **Browser** window lists loops in folders. It comes with genre folders of ready-made grooves: Disco, Funk, Hip-Hop, House, Latin, Pop, Reggae, Rock and Techno. Click a loop to see its description and a preview of the pattern. Double-click it, press **Load into sequencer**, or drag it onto the sequencer to load it. Loading replaces the current pattern, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings the old one back.

- **Save pattern** saves the tempo, the drums and the piano-roll notes into a folder, with an optional description. If the pattern came from a library loop, that loop's name is filled in and the button says **Replace**; type a new name to keep both.
- **New folder** adds a folder, for a genre, a student or a lesson.
- Drag a loop up or down the list to reorder it, or onto another folder's name to move it there. <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> moves the selected loop from the keyboard.

Every open Browser window updates when the library changes, including when Claude saves a loop.

Loops are plain JSON files in [library/](library/), one folder each. You can also add one by hand: drop a file like this into a folder, then press ↻ in the Browser:

```json
{
  "name": "Four on the Floor",
  "description": "Kick on every beat, snare on 2 and 4, open hi-hat on the off-beats.",
  "bpm": 120,
  "swing": 50,
  "stepsPerBeat": 4,
  "length": 16,
  "tracks": {
    "kick": "x... x... x... x...",
    "snare": ".... x... .... x...",
    "open_hat": { "steps": "..x. ..x. ..x. ..x.", "volume": 0.6 }
  }
}
```

Track keys are instrument names, and the step strings use the same notation as Claude's tools (see below). To have two tracks with the same sound, give the track its own name and an `instrument` field: `"Ghost Snare": { "instrument": "snare", "steps": "..." }`.

Synth tracks go under `"synths"`, keyed by sound the same way, with notes in the notation Claude reads them in: `"synths": { "bass": "A2@1+2 C3@7+2 G2@9+2" }`. Loading a loop with synth tracks replaces the piano roll's tracks; a drums-only loop leaves them as they are.

Each folder's `.order.json` remembers the order its loops were arranged in, and loops missing from it are listed after the others, by name. Saved loops land in [library/](library/) next to the built-in ones, so they show up in `git status`. Set `LIBRARY_DIR` to keep the library somewhere else.

## What Claude can do

| Tool            | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `get_state`     | Read the grid as text, plus the user's recent edits                |
| `list_loops` / `load_loop` | Browse the loop library and load a loop into the sequencer |
| `save_loop` / `move_loop` | Save the pattern into a library folder, and put loops in order |
| `set_pattern`   | Write whole tracks from step strings (one undo step)               |
| `set_steps`     | Change individual steps                                            |
| `set_notes`     | Write notes and chords on a synth track (piano roll)               |
| `set_transport` | Tempo, swing, length, subdivision, play and stop                   |
| `set_track`     | Volume, mute, solo, name, sound (drum or synth track)              |
| `add_track` / `remove_track` / `clear` | Arrange drum and synth tracks               |
| `show_note`     | Show an explanation beside the grid and highlight steps            |
| `undo`          | Undo recent changes, by either of you                              |

Step strings use one character per step: `X` accent, `x` hit, `o` ghost note, `.` rest. Spaces and `|` are ignored, so `"x... x... x... x..."` is four-on-the-floor. A short string repeats to fill the pattern: `"x.."` over 16 steps gives a 3-against-4 polyrhythm.

Notes are given as a pitch name (`"C4"` is middle C, `"F#2"`, `"Bb3"`), a start step and a length in steps. Claude reads them back as `pitch@step+length`, so `A2@1+2` is an A2 on step 1 that lasts two steps.

## How it works

```
 Browser (UI + Web Audio synth)  ⇄  WebSocket  ⇄  Node server  ⇄  MCP (HTTP /mcp)  ⇄  Claude
```

- [server/store.js](server/store.js) holds the single source of truth, with undo history, the activity log and persistence.
- [server/operations.js](server/operations.js) contains every edit. The browser and Claude go through the same functions, so they can't drift apart.
- [server/library.js](server/library.js) reads and writes the loop library on disk. The Browser reaches it under `/api/library`, and Claude through the library tools.
- [server/mcp.js](server/mcp.js) defines the MCP tools and the instructions Claude receives when it connects. It runs in stateless Streamable HTTP mode.
- [shared/synths.js](shared/synths.js) lists the synth sounds and converts between note names and MIDI numbers, for both the server and the browser.
- [public/pianoroll.js](public/pianoroll.js) is the Piano Roll window, and [public/browser.js](public/browser.js) the Browser.
- [public/audio.js](public/audio.js) synthesizes every drum and synth sound, so there are no samples to load. A look-ahead scheduler keeps timing tight, and it keeps playing in a background tab.
- [public/app.js](public/app.js) renders whatever state the server sends. Claude's edits briefly flash in the grid.
- [public/windows.js](public/windows.js) and [public/knob.js](public/knob.js) provide the draggable windows and rotary knobs.

## Self-hosting on your network

By default the server listens only on `127.0.0.1`. To reach it from other devices, such as a tablet in a classroom:

```sh
HOST=0.0.0.0 ALLOWED_HOSTS=localhost,127.0.0.1,studio.local PORT=3030 npm start
```

In PowerShell: `$env:HOST="0.0.0.0"; $env:ALLOWED_HOSTS="localhost,127.0.0.1,studio.local"; npm start`

There is no authentication. Anyone who can reach the port can edit the pattern, write to the loop library and use the MCP endpoint, so only do this on a network you trust. `ALLOWED_HOSTS` lists the hostnames the server accepts, which protects against DNS rebinding and cross-site WebSocket connections.
