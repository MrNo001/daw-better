// The browser windows the app shows in: the main page and the panels popped out of it into
// windows of their own (see windows.js). Every window runs on the main page's code, so the
// helpers here look in all of them: elements by id, listeners that every window needs, and
// animation frames.

const views = new Set([globalThis]);
const hooks = [];

/** The element with this id, in whichever window it's in. */
export function byId(id) {
  for (const view of views) {
    const node = view.document.getElementById(id);
    if (node) return node;
  }
  return null;
}

/** Run `hook(window)` for the main page now and for every window popped out later. */
export function eachWindow(hook) {
  hooks.push(hook);
  for (const view of views) hook(view);
}

/** The window the user last clicked or typed in. */
export function focusedView() {
  return views.has(lastUsed) ? lastUsed : globalThis;
}

let lastUsed = globalThis;
eachWindow((view) => {
  for (const type of ['pointerdown', 'keydown']) view.addEventListener?.(type, () => (lastUsed = view), true);
});

export function addView(view) {
  views.add(view);
  for (const hook of hooks) hook(view);
  if (pending) arm(view);
}

export function dropView(view) {
  views.delete(view);
  pending?.delete(view);
}

// --- animation frames ----------------------------------------------------------
// The browser only gives frames to a window that's on screen, and the main page may be
// minimised or behind a popped-out panel while that panel is in view. So every window is
// asked for the next frame, the first to give one runs it, and the others are let off.

let queue = new Map();
let nextId = 0;
let pending = null; // window -> its requestAnimationFrame id

function arm(view) {
  const id = view.requestAnimationFrame(() => pending?.get(view) === id && runFrame(view));
  pending.set(view, id);
}

function runFrame(view) {
  for (const [other, id] of pending) {
    if (other === view) continue;
    try {
      other.cancelAnimationFrame(id);
    } catch {
      // That window is closing.
    }
  }
  pending = null;
  const callbacks = queue;
  queue = new Map();
  const now = performance.now();
  for (const callback of callbacks.values()) callback(now);
}

/** Like requestAnimationFrame, from whichever window is on screen. */
export function requestFrame(callback) {
  queue.set(++nextId, callback);
  if (!pending) {
    pending = new Map();
    for (const view of views) arm(view);
  }
  return nextId;
}

export function cancelFrame(id) {
  queue.delete(id);
}
