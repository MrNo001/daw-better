// Holds the one authoritative sequencer state, with undo history, an activity log and
// persistence to disk. Emits 'change' after every edit so the server can broadcast it.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { defaultState, sanitize } from './operations.js';

const HISTORY_LIMIT = 200;
const ACTIVITY_LIMIT = 50;
const COALESCE_MS = 2000;

export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.state = this.load();
    this.past = [];
    this.future = [];
    this.activity = [];
    this.lastCommit = null;
    this.claudeLastSeen = null;
    this.saveTimer = null;
  }

  load() {
    try {
      return sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${this.file}, starting fresh: ${err.message}`);
      return defaultState();
    }
  }

  /**
   * Run `fn` against the state and broadcast the result. `fn` mutates the state and
   * returns a description. If it throws, the state is left untouched.
   * Edits sharing a `coalesce` key within a short window (a drag across cells, a
   * slider sweep) become a single undo step.
   */
  change(source, fn, { undoable = true, coalesce } = {}) {
    const before = structuredClone(this.state);
    let description;
    try {
      description = fn(this.state);
    } catch (err) {
      this.state = before;
      throw err;
    }
    if (JSON.stringify(before) === JSON.stringify(this.state)) return description;

    if (undoable) {
      const now = Date.now();
      const merge = coalesce && this.lastCommit?.key === coalesce && now - this.lastCommit.at < COALESCE_MS;
      if (!merge) {
        this.past.push(before);
        if (this.past.length > HISTORY_LIMIT) this.past.shift();
      }
      this.lastCommit = { key: coalesce, at: now };
      this.future = [];
    }
    this.commit(source, description, coalesce);
    return description;
  }

  undo(source, count = 1) {
    return this.travel(source, this.past, this.future, count, 'undo');
  }

  redo(source, count = 1) {
    return this.travel(source, this.future, this.past, count, 'redo');
  }

  travel(source, from, to, count, label) {
    let n = 0;
    for (; n < count && from.length; n++) {
      to.push(this.state);
      // Undo restores the music, not the transport or the on-screen note.
      this.state = { ...from.pop(), playing: this.state.playing, note: this.state.note };
    }
    if (n === 0) throw new Error(`Nothing to ${label}.`);
    this.lastCommit = null;
    this.commit(source, n > 1 ? `${label} ×${n}` : label);
    return n;
  }

  commit(source, text, coalesce) {
    const last = this.activity[0];
    if (coalesce && last?.coalesce === coalesce && last.source === source) {
      last.text = text;
      last.at = Date.now();
    } else {
      this.activity.unshift({ at: Date.now(), source, text, coalesce });
      this.activity.length = Math.min(this.activity.length, ACTIVITY_LIMIT);
    }
    this.emit('change', source);
    this.scheduleSave();
  }

  markClaudeSeen() {
    const previous = this.claudeLastSeen;
    this.claudeLastSeen = Date.now();
    if (!previous || this.claudeLastSeen - previous > 10_000) this.emit('change', null);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ ...this.state, playing: false }, null, 2));
    } catch (err) {
      console.error(`Could not save state: ${err.message}`);
    }
  }
}
