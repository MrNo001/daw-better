# Beat Lab

A self-hosted drum sequencer for experimenting with rhythm and teaching it, with Claude connected over MCP. You and Claude edit the same pattern: anything Claude writes appears in the grid right away and is heard live while it plays, and Claude can read back what you changed by hand.

This is the first piece of a larger DAW project built around experimenting with music and learning it with AI.

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
claude mcp add --scope user --transport http beat-lab http://127.0.0.1:3030/mcp
```

**Claude Desktop:** its config file launches local commands, so bridge to the HTTP endpoint with the community [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package:

```json
{
  "mcpServers": {
    "beat-lab": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:3030/mcp"] }
  }
}
```

The Beat Lab server has to be running for Claude to reach it. The Claude card in the app shows when Claude last connected.

Things to try:

- "Teach me a bossa nova beat, one layer at a time."
- "I just changed the hi-hats. What did that do to the feel?"
- "Make this swing like a J Dilla beat."
- "Quiz me: write a famous drum pattern and let me guess it."

## Using the sequencer

- Left-click a step to toggle it, or left-drag to paint steps on. Right-click erases a step, and right-drag erases everything it passes over. One drag is one undo step.
- <kbd>Shift</kbd>-click for an accent, <kbd>Alt</kbd>-click for a ghost note.
- Press a track's name button to hear its sound. The green light mutes the track, **S** solos it, and the knob sets its volume (drag up or down, double-click to reset).
- <kbd>Space</kbd> plays and stops. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redoes.
- **Tempo** and **Steps** in the display: drag up or down to change them, or click to type.
- **Grid** sets the subdivision: 16ths, 8ths, triplets, and so on. The counting row above the steps follows it ("1 e + a").
- **Swing** runs from 50% (straight) to 75%. 66% is a triplet shuffle.
- The sequencer, Browser and Claude panels are windows. Drag them by the title bar, and double-click a title bar to collapse it. This browser remembers where you put them. On narrow screens they stack.

The pattern is saved to `data/state.json` and restored when the server restarts. Set `DATA_FILE` to save somewhere else, for example to run separate instances side by side with different `PORT`s.

## Loop library

The **Browser** window lists ready-made loops in genre folders: Disco, Funk, Hip-Hop, House, Latin, Pop, Reggae, Rock and Techno. Click a loop to see its description and a preview of the pattern. Double-click it, press **Load into sequencer**, or drag it onto the sequencer to load it. Loading replaces the current pattern, and <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings the old one back.

Loops are plain JSON files in [library/](library/), one folder per genre. To add one, drop a file like this into a folder (new folders become new genres), then press ↻ in the Browser:

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

Track keys are instrument names, and the step strings use the same notation as Claude's tools (see below). To have two tracks with the same sound, give the track its own name and an `instrument` field: `"Ghost Snare": { "instrument": "snare", "steps": "..." }`. Set `LIBRARY_DIR` to keep the library somewhere else.

## What Claude can do

| Tool            | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `get_state`     | Read the grid as text, plus the user's recent edits                |
| `list_loops` / `load_loop` | Browse the loop library and load a loop into the sequencer |
| `set_pattern`   | Write whole tracks from step strings (one undo step)               |
| `set_steps`     | Change individual steps                                            |
| `set_transport` | Tempo, swing, length, subdivision, play and stop                   |
| `set_track`     | Volume, mute, solo, name, sound                                    |
| `add_track` / `remove_track` / `clear` | Arrange the kit                             |
| `show_note`     | Show an explanation beside the grid and highlight steps            |
| `undo`          | Undo recent changes, by either of you                              |

Step strings use one character per step: `X` accent, `x` hit, `o` ghost note, `.` rest. Spaces and `|` are ignored, so `"x... x... x... x..."` is four-on-the-floor. A short string repeats to fill the pattern: `"x.."` over 16 steps gives a 3-against-4 polyrhythm.

## How it works

```
 Browser (UI + Web Audio synth)  ⇄  WebSocket  ⇄  Node server  ⇄  MCP (HTTP /mcp)  ⇄  Claude
```

- [server/store.js](server/store.js) holds the single source of truth, with undo history, the activity log and persistence.
- [server/operations.js](server/operations.js) contains every edit. The browser and Claude go through the same functions, so they can't drift apart.
- [server/library.js](server/library.js) reads the loop library from disk. It's served to the Browser at `/api/library` and to Claude through `list_loops`.
- [server/mcp.js](server/mcp.js) defines the MCP tools and the instructions Claude receives when it connects. It runs in stateless Streamable HTTP mode.
- [public/audio.js](public/audio.js) synthesizes every drum sound, so there are no samples to load. A look-ahead scheduler keeps timing tight, and it keeps playing in a background tab.
- [public/app.js](public/app.js) renders whatever state the server sends. Claude's edits briefly flash in the grid.
- [public/windows.js](public/windows.js) and [public/knob.js](public/knob.js) provide the draggable windows and rotary knobs.

## Self-hosting on your network

By default the server listens only on `127.0.0.1`. To reach it from other devices, such as a tablet in a classroom:

```sh
HOST=0.0.0.0 ALLOWED_HOSTS=localhost,127.0.0.1,studio.local PORT=3030 npm start
```

In PowerShell: `$env:HOST="0.0.0.0"; $env:ALLOWED_HOSTS="localhost,127.0.0.1,studio.local"; npm start`

There is no authentication. Anyone who can reach the port can edit the pattern and use the MCP endpoint, so only do this on a network you trust. `ALLOWED_HOSTS` lists the hostnames the server accepts, which protects against DNS rebinding and cross-site WebSocket connections.
