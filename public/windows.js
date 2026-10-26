// Floating windows inside the workspace, like the panels of a desktop DAW. Drag a window
// by its title bar; double-click the title bar or press – to collapse it. Windows with the
// "resizable" class can be resized from their bottom-right corner. Positions and sizes are
// remembered in this browser. On narrow screens the windows stack instead.

const STORAGE_KEY = 'daw-better.windows.v3';
const KEEP_VISIBLE = 120; // px of a window that must stay on screen
const floating = matchMedia('(min-width: 900px)');

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

export function initWindows(workspace, defaults = {}) {
  const layout = loadLayout();
  const windows = [...workspace.querySelectorAll('.window')];
  let zTop = 10;

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
    const entry = { x: win.offsetLeft, y: win.offsetTop, collapsed: win.classList.contains('collapsed') };
    // The browser sets an inline size once the user drags the resize corner.
    if (win.style.width) entry.width = win.offsetWidth;
    if (win.style.height && !entry.collapsed) entry.height = win.offsetHeight;
    else if (layout[win.dataset.window]?.height) entry.height = layout[win.dataset.window].height;
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

  function place() {
    for (const win of windows) {
      if (!floating.matches) {
        win.style.left = win.style.top = win.style.maxHeight = win.style.width = win.style.height = '';
        continue;
      }
      const saved = layout[win.dataset.window];
      if (saved?.width) win.style.width = `${saved.width}px`;
      if (saved?.height) win.style.height = `${saved.height}px`;
      const pos = saved ?? defaults[win.dataset.window]?.(workspace, win) ?? { x: 24, y: 24 };
      move(win, pos.x, pos.y);
    }
  }

  for (const win of windows) {
    const bar = win.querySelector('.titlebar');
    setCollapsed(win, !!layout[win.dataset.window]?.collapsed);

    win.addEventListener('pointerdown', () => focus(win), true);

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || !floating.matches) return;
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
  // Windows the user hasn't moved go back to their default spot; call this once the
  // content that the defaults depend on (like the sequencer's height) has rendered.
  return { refresh: place };
  floating.addEventListener('change', place);
  addEventListener('resize', () => {
    if (floating.matches) for (const win of windows) move(win, win.offsetLeft, win.offsetTop);
  });
}
