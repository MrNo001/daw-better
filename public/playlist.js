// The Playlist window: the project's patterns on the left, and the song timeline on the right,
// where clips of those patterns sit on lanes. Clicking a pattern or one of its clips opens it in
// the sequencer and piano roll. Drag a pattern onto a lane, or click an empty spot to place the
// current pattern there; drag a clip to move it and its right edge to make it longer (the
// pattern repeats), right-click to delete, Ctrl+drag to copy. A loop dragged in from the Browser
// becomes a new pattern.

import { BEATS_PER_BAR, PATTERN_COLORS, patternBeats, barLabel, lengthLabel } from '/shared/patterns.js';
import { TICKS } from './audio.js';
import { LOOP_TYPE } from './browser.js';
import { byId as $, eachWindow } from './views.js';

const BEAT = 14; // px per beat
const LANE = 32; // px per lane
const HEADS = 26; // width of the lane-number column
const MIN_BARS = 32;
const MIN_LANES = 5;
const MAX_LANES = 16;
const PATTERN_TYPE = 'application/x-daw-better-pattern';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const newClipId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const colorOf = (pattern) => PATTERN_COLORS[pattern.color % PATTERN_COLORS.length];
const songEnd = (state) => Math.max(0, ...state.arrangement.map((c) => c.start + c.length));
const songBars = (state) => Math.ceil(songEnd(state) / BEATS_PER_BAR);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A small picture of a pattern's hits (top) and notes (bottom), drawn once per repetition of
// the pattern across its clips. Cached until the pattern changes.
const pictures = new Map();
function patternPicture(pattern) {
  const notes = pattern.synths.flatMap((s) => s.notes);
  const key = JSON.stringify([pattern.length, pattern.tracks.map((t) => t.steps), notes.map((n) => [n.pitch, n.start, n.length])]);
  const cached = pictures.get(pattern.id);
  if (cached?.key === key) return cached.url;

  const drums = pattern.tracks.filter((t) => t.steps.some((v) => v > 0));
  const split = drums.length && notes.length ? 48 : drums.length ? 100 : 0;
  const shapes = [];
  drums.forEach((track, row) => {
    const h = split / drums.length;
    track.steps.forEach((v, i) => {
      if (v > 0) shapes.push(`<rect x="${i + 0.15}" y="${row * h + h * 0.2}" width="0.7" height="${h * 0.6}"/>`);
    });
  });
  if (notes.length) {
    const pitches = notes.map((n) => n.pitch);
    const top = split ? split + 6 : 4;
    const high = Math.max(...pitches);
    const h = Math.min((96 - top) / (high - Math.min(...pitches) + 1), 14);
    for (const n of notes) {
      shapes.push(`<rect x="${n.start + 0.08}" y="${top + (high - n.pitch) * h}" width="${n.length - 0.16}" height="${h * 0.8}"/>`);
    }
  }
  // A faint line where each repetition starts.
  const line = `<rect width="${pattern.stepsPerBeat / BEAT}" height="100" fill-opacity="0.3"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pattern.length} 100" preserveAspectRatio="none">` +
    `<g fill="#000" fill-opacity="0.5">${shapes.join('')}</g>${line}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  pictures.set(pattern.id, { key, url });
  return url;
}

export function createPlaylist({ act, getState, toast }) {
  const list = $('pattern-list');
  const scroll = $('arrange-scroll');
  const ruler = $('arrange-ruler');
  const heads = $('arrange-heads');
  const lanes = $('arrange-lanes');
  const snapSelect = $('arrange-snap');
  const playhead = el('div', 'arrange-playhead');
  const ghost = el('div', 'clip ghost');
  ghost.hidden = true;

  let gesture = null;
  let renaming = null; // id of the pattern whose name is being edited
  let draggedPattern = null; // id of a pattern being dragged out of the list
  let bars = MIN_BARS;
  let laneCount = MIN_LANES;
  let gridSignature = '';
  let lastX = null;

  $('arrange').style.cssText = `--beat:${BEAT}px; --lane:${LANE}px; --heads:${HEADS}px`;

  const snap = () => Number(snapSelect.value);
  const findPattern = (id) => getState().patterns.find((p) => p.id === id) ?? null;

  function render() {
    const state = getState();
    if (!state) return;
    renderPatterns(state);
    renderTimeline(state);
    const clips = state.arrangement.length;
    $('playlist-meta').textContent = clips ? `${lengthLabel(songBars(state) * BEATS_PER_BAR)} · ${clips} clip${clips === 1 ? '' : 's'}` : 'empty';
    $('arrange-mode').textContent =
      state.mode === 'song' ? 'Song mode: Play plays this arrangement' : 'Pattern mode: Play loops the current pattern. Switch to Song to hear this.';
    $('arrange-mode').classList.toggle('song', state.mode === 'song');
  }

  // --- pattern list --------------------------------------------------------------

  function renderPatterns(state) {
    if (renaming) return; // don't take the name field away while it's being typed in
    const { activeElement } = list.ownerDocument;
    const focused = list.contains(activeElement) ? activeElement.closest('.pattern-item')?.dataset.id : null;
    list.replaceChildren(
      ...state.patterns.map((pattern) => {
        const current = pattern.id === state.current;
        const item = el('li', `pattern-item${current ? ' current' : ''}`);
        item.dataset.id = pattern.id;
        item.draggable = true;
        item.tabIndex = 0;
        item.setAttribute('aria-current', current);
        item.title = `${pattern.name}: click to edit it, drag it onto a lane to add it to the song, double-click to rename`;
        item.style.setProperty('--c', colorOf(pattern));
        const add = el('button', 'pattern-place', 'Add');
        add.title = 'Add it to the end of the song';
        const remove = el('button', 'pattern-rm', '×');
        remove.title = `Delete ${pattern.name}`;
        remove.setAttribute('aria-label', `Delete ${pattern.name}`);
        remove.disabled = state.patterns.length === 1;
        item.append(
          el('span', 'pattern-swatch'),
          el('span', 'pattern-name', pattern.name),
          el('span', 'pattern-length', lengthLabel(pattern.length / pattern.stepsPerBeat)),
          add,
          remove,
        );
        return item;
      }),
    );
    if (focused) list.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus();
  }

  function deletePattern(id) {
    const pattern = findPattern(id);
    if (!pattern || getState().patterns.length === 1) return;
    act('deletePattern', { pattern: id });
    toast(`Deleted “${pattern.name}”. Ctrl+Z brings it back.`, 'info');
  }

  // Rename in place: Enter or clicking away saves, Escape cancels.
  function startRename(id) {
    const item = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const pattern = findPattern(id);
    if (!item || !pattern) return;
    renaming = id;
    const input = el('input', 'tree-input pattern-input');
    input.type = 'text';
    input.maxLength = 40;
    input.value = pattern.name;
    input.setAttribute('aria-label', 'Pattern name');
    item.draggable = false;
    item.querySelector('.pattern-name').replaceWith(input);
    input.focus();
    input.select();
    const finish = (save, refocus) => {
      if (renaming !== id) return;
      renaming = null;
      const name = input.value.trim();
      if (save && name && name !== pattern.name) act('renamePattern', { pattern: id, name });
      render();
      if (refocus) list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true, true);
      if (e.key === 'Escape') finish(false, true);
    });
    input.addEventListener('blur', () => finish(true, false));
  }

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.pattern-item');
    if (!item || renaming) return;
    const id = item.dataset.id;
    if (e.target.closest('.pattern-rm')) return deletePattern(id);
    if (e.target.closest('.pattern-place')) return act('addClip', { pattern: id });
    act('selectPattern', { pattern: id });
  });
  list.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.pattern-item');
    if (item && !e.target.closest('button, input')) startRename(item.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.pattern-item');
    if (!item || e.target !== item) return;
    if (e.key === 'Enter') act('selectPattern', { pattern: item.dataset.id });
    if (e.key === 'F2') startRename(item.dataset.id);
    if (e.key === 'Delete') deletePattern(item.dataset.id);
  });
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.pattern-item');
    if (!item) return;
    draggedPattern = item.dataset.id;
    e.dataTransfer.setData(PATTERN_TYPE, item.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  $('pattern-add').addEventListener('click', () => act('newPattern'));
  $('pattern-copy').addEventListener('click', () => act('newPattern', { copy: true }));

  // --- timeline ------------------------------------------------------------------

  function buildGrid() {
    const width = `${bars * BEATS_PER_BAR * BEAT}px`;
    ruler.style.width = width;
    lanes.style.width = width;
    lanes.style.height = `${laneCount * LANE}px`;
    ruler.replaceChildren(...Array.from({ length: bars }, (_, i) => el('span', '', String(i + 1))));
    heads.replaceChildren(...Array.from({ length: laneCount }, (_, i) => el('span', '', String(i + 1))));
  }

  function clipElement(clip, pattern, state) {
    const node = el('div', `clip${pattern.id === state.current ? ' current' : ''}`);
    node.dataset.id = clip.id;
    node.title = `${pattern.name}, ${barLabel(clip.start)}, ${lengthLabel(clip.length)}. Click to edit the pattern, drag to move, Ctrl+drag to copy`;
    node.style.cssText = `left:${clip.start * BEAT}px; top:${clip.lane * LANE}px; width:${clip.length * BEAT}px; --c:${colorOf(pattern)}`;
    const picture = el('span', 'clip-picture');
    picture.style.backgroundImage = patternPicture(pattern);
    picture.style.backgroundSize = `${(pattern.length / pattern.stepsPerBeat) * BEAT}px 100%`;
    node.append(el('span', 'clip-name', pattern.name), picture, el('span', 'clip-handle'));
    return node;
  }

  function renderTimeline(state) {
    // Room past the end of the song and one empty lane below the last one used. Nothing shrinks
    // while a clip is being dragged, so the grid doesn't move under the pointer.
    const needBars = Math.max(MIN_BARS, songBars(state) + 8);
    const needLanes = clamp(Math.max(0, ...state.arrangement.map((c) => c.lane + 2)), MIN_LANES, MAX_LANES);
    bars = gesture ? Math.max(bars, needBars) : needBars;
    laneCount = gesture ? Math.max(laneCount, needLanes) : needLanes;
    if (`${bars}/${laneCount}` !== gridSignature) {
      gridSignature = `${bars}/${laneCount}`;
      buildGrid();
    }

    const items = [];
    for (const clip of state.arrangement) {
      const pattern = state.patterns.find((p) => p.id === clip.pattern);
      if (pattern) items.push(clipElement(clip, pattern, state));
    }
    if (state.arrangement.length) {
      const end = el('div', 'song-end');
      end.style.left = `${songBars(state) * BEATS_PER_BAR * BEAT}px`;
      end.title = 'End of the song: song mode starts over from bar 1 here';
      items.push(end);
    }
    lanes.replaceChildren(...items, ghost, playhead);
  }

  function setPlayhead(tick) {
    playhead.classList.toggle('on', tick >= 0);
    if (tick < 0) {
      lastX = null;
      return;
    }
    const x = (tick / TICKS) * BEAT;
    playhead.style.transform = `translateX(${x}px)`;
    // Follow the playhead when it runs off the visible part, unless the user scrolled away from it.
    const visible = (px) => px >= scroll.scrollLeft && px <= scroll.scrollLeft + scroll.clientWidth - HEADS - 16;
    if (!gesture && lastX !== null && visible(lastX) && !visible(x)) scroll.scrollLeft = Math.max(0, x - 16);
    lastX = x;
  }

  // --- editing clips -------------------------------------------------------------

  function pointAt(e) {
    const r = lanes.getBoundingClientRect();
    return {
      beat: Math.max(0, (e.clientX - r.left) / BEAT),
      lane: clamp(Math.floor((e.clientY - r.top) / LANE), 0, laneCount - 1),
    };
  }

  const clipUnder = (target) => {
    const node = target?.closest?.('.clip:not(.ghost)');
    return node ? (getState().arrangement.find((c) => c.id === node.dataset.id) ?? null) : null;
  };

  // Apply a change locally right away so dragging feels immediate; the server confirms it.
  function place(clip) {
    getState().arrangement.push({ ...clip });
    act('addClip', clip, gesture?.stroke);
    renderTimeline(getState());
  }

  function update(clip, changes) {
    Object.assign(clip, changes);
    const local = getState().arrangement.find((c) => c.id === clip.id);
    if (local) Object.assign(local, changes);
    act('updateClip', { id: clip.id, ...changes }, gesture.stroke);
    renderTimeline(getState());
  }

  function erase(clip) {
    if (gesture.erased.has(clip.id)) return;
    gesture.erased.add(clip.id);
    const state = getState();
    state.arrangement = state.arrangement.filter((c) => c.id !== clip.id);
    act('deleteClips', { ids: [clip.id] }, gesture.stroke);
    renderTimeline(state);
  }

  lanes.addEventListener('contextmenu', (e) => e.preventDefault());

  lanes.addEventListener('pointerdown', (e) => {
    const state = getState();
    if (!state || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    lanes.setPointerCapture(e.pointerId);
    const clip = clipUnder(e.target);
    gesture = { stroke: `${Date.now()}-${Math.random().toString(36).slice(2)}`, erased: new Set(), moved: false };

    if (e.button === 2) {
      gesture.kind = 'erase';
      if (clip) erase(clip);
      return;
    }
    const at = pointAt(e);
    if (clip && e.target.closest('.clip-handle')) {
      Object.assign(gesture, { kind: 'resize', clip: { ...clip } });
    } else if (clip) {
      Object.assign(gesture, { kind: 'move', clip: { ...clip }, grab: at.beat - clip.start, copy: e.ctrlKey || e.metaKey, open: clip.pattern });
    } else {
      // An empty spot: put the current pattern there, at the start of the bar (or beat) clicked.
      const start = Math.floor(at.beat / snap()) * snap();
      const created = { id: newClipId(), pattern: state.current, lane: at.lane, start, length: patternBeats(state.pattern) };
      place(created);
      Object.assign(gesture, { kind: 'move', clip: created, grab: at.beat - start, moved: true });
    }
  });

  lanes.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    if (gesture.kind === 'erase') {
      const clip = clipUnder(lanes.ownerDocument.elementFromPoint(e.clientX, e.clientY));
      if (clip) erase(clip);
      return;
    }
    const at = pointAt(e);
    const unit = snap();
    const { clip } = gesture;
    if (gesture.kind === 'move') {
      const start = Math.max(0, Math.round((at.beat - gesture.grab) / unit) * unit);
      if (start === clip.start && at.lane === clip.lane) return;
      gesture.moved = true;
      if (gesture.copy) {
        // Ctrl+drag leaves the original where it was and moves a copy.
        gesture.copy = false;
        gesture.clip = { ...clip, id: newClipId(), start, lane: at.lane };
        place(gesture.clip);
      } else {
        update(clip, { start, lane: at.lane });
      }
    } else {
      const length = Math.max(1, Math.round((at.beat - clip.start) / unit) * unit);
      if (length === clip.length) return;
      gesture.moved = true;
      update(clip, { length });
    }
  });

  lanes.addEventListener('pointerup', () => {
    // Clicking a clip without dragging it opens its pattern.
    if (gesture?.kind === 'move' && !gesture.moved && gesture.open) act('selectPattern', { pattern: gesture.open });
    gesture = null;
    renderTimeline(getState());
  });
  lanes.addEventListener('pointercancel', () => (gesture = null));

  // --- dropping patterns and Browser loops ---------------------------------------

  function dropSpot(e) {
    const at = pointAt(e);
    return { lane: at.lane, start: Math.floor(at.beat / snap()) * snap() };
  }

  function showGhost({ lane, start }, beats, color) {
    ghost.hidden = false;
    ghost.style.cssText = `left:${start * BEAT}px; top:${lane * LANE}px; width:${beats * BEAT}px; --c:${color}`;
  }

  lanes.addEventListener('dragover', (e) => {
    const pattern = e.dataTransfer.types.includes(PATTERN_TYPE) ? findPattern(draggedPattern) : null;
    if (!pattern && !e.dataTransfer.types.includes(LOOP_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // A loop's length isn't known until it's loaded; most are a bar.
    showGhost(dropSpot(e), pattern ? patternBeats(pattern) : BEATS_PER_BAR, pattern ? colorOf(pattern) : 'var(--muted)');
  });
  lanes.addEventListener('dragleave', (e) => {
    if (!lanes.contains(e.relatedTarget)) ghost.hidden = true;
  });
  lanes.addEventListener('drop', (e) => {
    ghost.hidden = true;
    const patternId = e.dataTransfer.getData(PATTERN_TYPE);
    const loopId = e.dataTransfer.getData(LOOP_TYPE);
    if (!patternId && !loopId) return;
    e.preventDefault();
    const spot = dropSpot(e);
    if (patternId) act('addClip', { id: newClipId(), pattern: patternId, ...spot });
    else act('loadLoop', { id: loopId, asNew: true, clip: spot });
  });
  // A drag ends in the window it started in, which may be another popped-out window.
  eachWindow((view) =>
    view.addEventListener('dragend', () => {
      draggedPattern = null;
      ghost.hidden = true;
    }),
  );

  return { render, setPlayhead };
}
