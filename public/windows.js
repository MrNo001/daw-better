// Floating windows inside the workspace, like the panels of a desktop DAW. Drag a window
// by its title bar; double-click the title bar or press – to collapse it. Windows with the
// "resizable" class can be resized from their bottom-right corner. Positions and sizes are
// remembered in this browser. On narrow screens the windows stack instead.
//
// ↗ pops a window out into a browser window of its own, to put on another screen; ↙ or
// closing that window puts it back. The panel keeps running on this page's code (popout.js
// only hands it over), so the audio, meters and playheads carry on as before.

import { addView, dropView } from './views.js';

const STORAGE_KEY = 'daw-better.windows.v3';
const KEEP_VISIBLE = 120; // px of a window that must stay on screen
const POPUP_NAME = 'daw-better:'; // + the window's name

function loadLayout() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage can be unavailable (private mode); positions just won't persist.
  }
}

// Moving a window to another document scrolls everything in it back to the top.
function keepingScroll(win, move) {
  const scrolled = [win, ...win.querySelectorAll('*')].filter((n) => n.scrollTop || n.scrollLeft).map((n) => [n, n.scrollLeft, n.scrollTop]);
  move();
  for (const [node, left, top] of scrolled) {
    node.scrollLeft = left;
    node.scrollTop = top;
  }
}

export function initWindows(workspace, defaults = {}, { toast } = {}) {
  const layout = loadLayout();
  const windows = [...workspace.querySelectorAll('.window')];
  const floating = matchMedia('(min-width: 900px)');
  const popups = new Map(); // window name -> the browser window it's popped out into
  const moves = new Map(); // window name -> where its new browser window should go
  let zTop = 10;

  const isPopped = (win) => popups.has(win.dataset.window);

  function move(win, x, y) {
    const width = workspace.clientWidth;
    const height = workspace.clientHeight;
    const left = Math.min(Math.max(x, KEEP_VISIBLE - win.offsetWidth), width - KEEP_VISIBLE);
    const top = Math.min(Math.max(y, 0), Math.max(0, height - 40));
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
    win.style.maxHeight = `${height - top - 12}px`;
  }

  function remember(win) {
    if (isPopped(win)) return;
    const saved = layout[win.dataset.window];
    const entry = { x: win.offsetLeft, y: win.offsetTop, collapsed: win.classList.contains('collapsed') };
    // The browser sets an inline size once the user drags the resize corner.
    if (win.style.width) entry.width = win.offsetWidth;
    if (win.style.height && !entry.collapsed) entry.height = win.offsetHeight;
    else if (saved?.height) entry.height = saved.height;
    if (saved?.popup) entry.popup = saved.popup;
    layout[win.dataset.window] = entry;
    saveLayout(layout);
  }

  function focus(win) {
    win.style.zIndex = ++zTop;
    for (const w of windows) w.classList.toggle('focused', w === win);
  }

  function setCollapsed(win, collapsed) {
    win.classList.toggle('collapsed', collapsed);
    const button = win.querySelector('[data-collapse]');
    if (button) {
      button.textContent = collapsed ? '+' : '–';
      button.setAttribute('aria-label', collapsed ? 'Expand window' : 'Collapse window');
    }
  }

  function placeOne(win) {
    if (!floating.matches) {
      win.style.left = win.style.top = win.style.maxHeight = win.style.width = win.style.height = '';
      return;
    }
    const saved = layout[win.dataset.window];
    if (saved?.width) win.style.width = `${saved.width}px`;
    if (saved?.height) win.style.height = `${saved.height}px`;
    const pos = saved?.x !== undefined ? saved : (defaults[win.dataset.window]?.(workspace, win) ?? { x: 24, y: 24 });
    move(win, pos.x, pos.y);
  }

  function place() {
    for (const win of windows) if (!isPopped(win)) placeOne(win);
  }

  // --- popping out ---------------------------------------------------------------

  function rememberPopup(name, view) {
    if (!view.innerWidth) return; // already gone
    layout[name] = { ...layout[name], popup: { left: view.screenX, top: view.screenY, width: view.innerWidth, height: view.innerHeight } };
    saveLayout(layout);
  }

  function setPopButton(win, popped) {
    const button = win.querySelector('[data-popout]');
    button.textContent = popped ? '↙' : '↗';
    button.title = popped ? 'Put back in the main window' : 'Pop out into its own window, to put on another screen';
    button.setAttribute('aria-label', button.title);
  }

  // Opens the browser window; the window then asks for the panel (popout.js calls adopt).
  function popOut(win) {
    const name = win.dataset.window;
    const rect = win.getBoundingClientRect();
    // The first time, right where the window is now; after that, where it was last.
    const spot = layout[name]?.popup ?? {
      left: Math.round(screenX + rect.left),
      top: Math.round(screenY + outerHeight - innerHeight + rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    // Browsers keep a new window on this one's screen unless the page may place windows on
    // every screen (the Window Management API, in Chrome and Edge). Ask when it's needed:
    // the first time a window should go back to another screen.
    const elsewhere = screen.isExtended && !(spot.left >= screen.availLeft && spot.left < screen.availLeft + screen.availWidth);
    if (elsewhere && 'getScreenDetails' in window) moves.set(name, { spot, allowed: getScreenDetails().catch(() => null) });
    const view = open('popout.html', POPUP_NAME + name, `popup,left=${spot.left},top=${spot.top},width=${spot.width},height=${spot.height}`);
    if (!view) toast?.('The browser blocked the new window. Allow pop-ups for this page, then try again.');
  }

  function adopt(view) {
    const name = String(view.name).slice(POPUP_NAME.length);
    const win = windows.find((w) => w.dataset.window === name);
    if (!win || !view.name.startsWith(POPUP_NAME)) return view.close();
    const doc = view.document;
    popups.set(name, view);
    setCollapsed(win, false);
    setPopButton(win, true);
    win.style.left = win.style.top = win.style.maxHeight = win.style.width = win.style.height = win.style.zIndex = '';
    keepingScroll(win, () => doc.body.replaceChildren(win));
    doc.title = `${win.querySelector('.title').textContent} · daw-better`;
    addView(view);
    // Over to the other screen, once allowed (moving it before it has opened does nothing).
    const pending = moves.get(name);
    moves.delete(name);
    pending?.allowed.then((details) => details && !view.closed && view.moveTo(pending.spot.left, pending.spot.top));

    let timer;
    view.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => rememberPopup(name, view), 300);
    });
    // Closed, or reloading: the panel comes back here (a reload then pops it out again).
    view.addEventListener('pagehide', () => win.ownerDocument === doc && dock(win, false));
  }

  function dock(win, close = true) {
    const name = win.dataset.window;
    const view = popups.get(name);
    if (!view) return;
    rememberPopup(name, view);
    popups.delete(name);
    dropView(view);
    setPopButton(win, false);
    // Back to its place in the stacking order of the page.
    const after = windows.slice(windows.indexOf(win) + 1).find((w) => w.parentNode === workspace);
    keepingScroll(win, () => workspace.insertBefore(win, after ?? null));
    placeOne(win);
    focus(win);
    if (close) view.close();
  }

  // popout.js finds this page through its opener, also after this page reloads.
  window.dawBetter = { adopt };
  // Its pagehide may not come if the browser kills the window outright.
  setInterval(() => {
    for (const win of windows) if (popups.get(win.dataset.window)?.closed) dock(win, false);
  }, 1000);
  addEventListener('pagehide', () => {
    for (const [name, view] of popups) rememberPopup(name, view);
  });

  // --- input ---------------------------------------------------------------------

  for (const win of windows) {
    const bar = win.querySelector('.titlebar');
    setCollapsed(win, !!layout[win.dataset.window]?.collapsed);

    const pop = document.createElement('button');
    pop.className = 'win-btn';
    pop.dataset.popout = '';
    bar.insertBefore(pop, bar.querySelector('[data-collapse]'));
    setPopButton(win, false);
    pop.addEventListener('click', () => (isPopped(win) ? dock(win) : popOut(win)));

    win.addEventListener('pointerdown', () => focus(win), true);

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || !floating.matches || isPopped(win)) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const offsetX = e.clientX - win.offsetLeft;
      const offsetY = e.clientY - win.offsetTop;
      win.classList.add('dragging');
      const drag = (ev) => move(win, ev.clientX - offsetX, ev.clientY - offsetY);
      const drop = () => {
        win.classList.remove('dragging');
        bar.removeEventListener('pointermove', drag);
        bar.removeEventListener('pointerup', drop);
        bar.removeEventListener('pointercancel', drop);
        remember(win);
      };
      bar.addEventListener('pointermove', drag);
      bar.addEventListener('pointerup', drop);
      bar.addEventListener('pointercancel', drop);
    });

    const toggle = () => {
      if (isPopped(win)) return;
      setCollapsed(win, !win.classList.contains('collapsed'));
      remember(win);
    };
    bar.addEventListener('dblclick', (e) => !e.target.closest('button') && toggle());
    win.querySelector('[data-collapse]')?.addEventListener('click', toggle);

    if (win.classList.contains('resizable')) {
      let timer;
      new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => floating.matches && win.style.width && remember(win), 300);
      }).observe(win);
    }
  }

  place();
  focus(windows[0]);
  floating.addEventListener('change', place);
  addEventListener('resize', () => {
    if (floating.matches) for (const win of windows) if (!isPopped(win)) move(win, win.offsetLeft, win.offsetTop);
  });
  // Bring a window to the front, expanded; on narrow screens, scroll to it.
  function show(name) {
    const win = windows.find((w) => w.dataset.window === name);
    if (!win) return;
    if (isPopped(win)) return popups.get(name).focus();
    if (win.classList.contains('collapsed')) {
      setCollapsed(win, false);
      remember(win);
    }
    focus(win);
    if (!floating.matches) win.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Windows the user hasn't moved go back to their default spot; call this once the
  // content that the defaults depend on (like the sequencer's height) has rendered.
  return { refresh: place, show };
}
