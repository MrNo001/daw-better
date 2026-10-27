// daw-better server: serves the web UI, keeps browsers in sync over a WebSocket, and exposes
// the same sequencer to Claude as an MCP server at /mcp.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.js';
import { Library, loopFile } from './library.js';
import { createMcpServer } from './mcp.js';
import * as ops from './operations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? '127.0.0.1';
// Hostnames allowed to reach the server. Needed when HOST is 0.0.0.0, e.g. "localhost,studio.local".
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const allowedHosts = ALLOWED_HOSTS ?? (['127.0.0.1', 'localhost', '::1'].includes(HOST) ? LOCAL_HOSTS : null);
const appUrl = `http://localhost:${PORT}`;

// Where the pattern is saved. Set DATA_FILE to run several independent instances.
const store = new Store(process.env.DATA_FILE ?? path.join(root, 'data', 'state.json'));
const library = new Library(process.env.LIBRARY_DIR ?? path.join(root, 'library'));

// Host-header validation (DNS rebinding protection) and JSON body parsing.
const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.get('/api/library', (req, res) => res.json(library.list()));

// Browsers send an Origin header with every POST, so other sites can't change the library.
function sameOrigin({ headers: { origin, host } }) {
  if (!origin) return true; // not a browser
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Library edits from the Browser window. Each answers with JSON, or { error } and a status.
function libraryRoute(handler) {
  return (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Requests from other sites are not allowed.' });
    try {
      res.json(handler(req.body ?? {}));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  };
}

app.post(
  '/api/library/folders',
  libraryRoute(({ name }) => {
    const folder = library.createFolder(name);
    store.change('user', () => `made the folder ${folder}`, { undoable: false, record: true });
    return { name: folder };
  }),
);

app.post(
  '/api/library/loops',
  libraryRoute(({ folder, name, description, overwrite }) => {
    const saved = library.save(folder, loopFile(store.state, { name, description }), { overwrite: !!overwrite });
    store.change('user', (s) => ops.markSaved(s, saved), { undoable: false, record: true });
    return saved;
  }),
);

app.post(
  '/api/library/move',
  libraryRoute(({ id, folder, index }) => {
    const moved = library.move(id, folder, index);
    // Reordering inside a folder isn't worth an activity entry; moving to another folder is.
    store.change('user', (s) => ops.loopMoved(s, moved), { undoable: false, record: moved.id !== moved.from });
    return moved;
  }),
);

const server = http.createServer(app);

// Browsers don't apply CORS to WebSockets, so check the Origin to stop other sites
// from connecting to the local server.
function verifyClient({ origin }) {
  if (!origin || !allowedHosts) return true;
  try {
    return allowedHosts.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ server, path: '/ws', verifyClient });

function audience() {
  let clients = 0;
  let audioReady = 0;
  for (const client of wss.clients) {
    clients++;
    if (client.audioReady) audioReady++;
  }
  return { clients, audioReady };
}

function syncMessage(source = null) {
  return JSON.stringify({
    type: 'sync',
    source,
    state: store.state,
    activity: store.activity,
    meta: { claudeLastSeen: store.claudeLastSeen, canUndo: store.past.length > 0, canRedo: store.future.length > 0 },
  });
}

function broadcast(message) {
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
}

store.on('change', (source) => broadcast(syncMessage(source)));
// Every open Browser window reloads the library, whoever changed it.
library.on('change', () => broadcast(JSON.stringify({ type: 'library' })));

const UI_ACTIONS = {
  setSteps: ops.setSteps,
  setTransport: ops.setTransport,
  setTrack: ops.setTrack,
  addTrack: ops.addTrack,
  removeTrack: ops.removeTrack,
  clearTracks: ops.clearTracks,
  addNote: ops.addNote,
  updateNote: ops.updateNote,
  deleteNotes: ops.deleteNotes,
};

function handleAction({ name, args = {}, stroke }) {
  if (name === 'undo') return store.undo('user');
  if (name === 'redo') return store.redo('user');
  if (name === 'setPlaying') return store.change('user', (s) => ops.setPlaying(s, args), { undoable: false });
  if (name === 'setNote') return store.change('user', (s) => ops.setNote(s, args), { undoable: false });
  if (name === 'loadLoop') return store.change('user', (s) => ops.loadLoop(s, library.get(args.id)));
  if (!Object.hasOwn(UI_ACTIONS, name)) throw new Error(`Unknown action "${name}".`);
  return store.change('user', (s) => UI_ACTIONS[name](s, args), { coalesce: stroke });
}

wss.on('connection', (ws) => {
  ws.audioReady = false;
  ws.send(syncMessage());
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'audio') {
      ws.audioReady = !!msg.ready;
      return;
    }
    if (msg.type !== 'action') return;
    try {
      handleAction(msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });
});

// MCP over Streamable HTTP, stateless: a new server and transport per request.
app.post('/mcp', async (req, res) => {
  store.markClaudeSeen();
  const mcp = createMcpServer({ store, library, audience, appUrl });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const methodNotAllowed = (req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

server.listen(PORT, HOST, () => {
  console.log(`daw-better is running at ${appUrl}`);
  console.log(`MCP endpoint: http://127.0.0.1:${PORT}/mcp`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    store.flush();
    process.exit(0);
  });
}
