// The Browser window: the loop library as a tree of folders. Click a loop to preview it, and
// double-click it, press Load or drag it onto the sequencer to load it. "Save pattern" writes
// the current pattern into a folder and "New folder" adds one. Dragging a loop inside the tree
// reorders it or moves it to another folder; Alt+↑/↓ moves the focused loop.

import { INSTRUMENTS } from '/shared/instruments.js';
import { SYNTHS } from '/shared/synths.js';

const LOOP_TYPE = 'application/x-daw-better-loop';
const OPEN_FOLDERS_KEY = 'daw-better.browser.open';
const colors = Object.fromEntries([...INSTRUMENTS, ...SYNTHS].map((s) => [s.id, s.color]));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function post(path, body) {
  const res = await fetch(`/api/library/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = await res.json().catch(() => ({}));
  if (res.ok) return reply;
  if (reply.error) throw new Error(reply.error);
  // No JSON error: most likely a server started before this feature existed.
  throw new Error(res.status === 404 ? 'The server needs a restart to do this. Stop it and run npm start again.' : `The server answered ${res.status}.`);
}

// Which steps a synth track sounds on, for the preview: a note lights every step it covers.
function noteSteps(synth, length) {
  const steps = new Array(length).fill(0);
  for (const n of synth.notes) for (let i = n.start; i < n.start + n.length; i++) steps[i] = Math.max(steps[i], n.velocity);
  return steps;
}

export function createBrowser({ act, getState, toast, sequencerWindow }) {
  const $ = (id) => document.getElementById(id);
  const tree = $('library');
  const form = $('save-form');
  const nameInput = $('save-name');
  const folderSelect = $('save-folder');
  const descriptionInput = $('save-description');
  const submit = $('save-submit');
  const preview = $('loop-preview');

  let library = [];
  let selectedId = null;
  let selectedFolder = null; // where "Save pattern" saves to by default
  let openFolders = null;
  let previewed = null;
  let newFolderRow = null;
  let dragging = null; // id of the loop being dragged
  let hover = null;
  let descriptionEdited = false;

  const findLoop = (id) => library.flatMap((f) => f.loops).find((l) => l.id === id) ?? null;
  const findFolder = (name) => library.find((f) => f.name === name) ?? null;

  function saveOpenFolders() {
    try {
      localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders]));
    } catch {
      // Not persisting which folders are open is fine.
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) throw new Error();
      library = await res.json();
    } catch {
      toast('Could not load the loop library.');
      return;
    }
    if (!openFolders) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY));
      } catch {}
      openFolders = new Set(saved ?? [getState()?.loop?.id.split('/')[0] ?? library[0]?.name].filter(Boolean));
    }
    selectedId ??= getState()?.loop?.id ?? null;
    render();
  }

  // --- tree --------------------------------------------------------------------

  function loopItem(loop) {
    const li = el('li', 'tree-row loop-row');
    li.dataset.id = loop.id;
    li.setAttribute('role', 'treeitem');
    li.tabIndex = 0;
    li.draggable = true;
    li.title = `${loop.name}: double-click or drag onto the sequencer to load, drag up or down to reorder`;
    li.append(el('span', 'loop-icon'), el('span', 'loop-label', loop.name), el('span', 'loop-bpm', String(loop.bpm)));
    return li;
  }

  function folderItem(folder) {
    const item = el('li', 'folder');
    item.dataset.folder = folder.name;
    item.setAttribute('role', 'treeitem');
    const row = el('button', 'tree-row');
    row.append(el('span', 'chevron'), el('span', 'folder-icon'), el('span', 'folder-name', folder.name), el('span', 'tree-count', String(folder.loops.length)));
    const group = el('ul');
    group.setAttribute('role', 'group');
    group.append(...folder.loops.map(loopItem));
    if (folder.loops.length === 0) {
      const empty = el('li', 'tree-row empty-row', 'Empty folder');
      empty.title = 'Save a pattern here, or drag loops in';
      group.append(empty);
    }
    item.append(row, group);
    return item;
  }

  function render() {
    const focused = tree.contains(document.activeElement) ? document.activeElement.closest('.loop-row')?.dataset.id : null;
    // The new-folder field stays put, so a reload while typing a name doesn't interrupt it.
    for (const child of [...tree.children]) if (child !== newFolderRow) child.remove();
    if (library.length) tree.append(...library.map(folderItem));
    else tree.append(el('li', 'tree-row muted', 'No folders yet. Press New folder to make one.'));
    if (!form.hidden) fillFolders();
    renderState(); // opens folders first: a row in a closed folder can't take focus
    if (focused) tree.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus();
  }

  function renderState() {
    const current = getState()?.loop?.id;
    for (const folder of tree.querySelectorAll('.folder')) {
      const open = !!openFolders?.has(folder.dataset.folder);
      folder.classList.toggle('open', open);
      folder.setAttribute('aria-expanded', open);
    }
    for (const row of tree.querySelectorAll('.loop-row')) {
      row.classList.toggle('selected', row.dataset.id === selectedId);
      row.classList.toggle('current', row.dataset.id === current);
    }
    renderDetails();
  }

  function previewRow(color, steps, stepsPerBeat) {
    const row = el('div', 'preview-row');
    row.style.setProperty('--c', color);
    steps.forEach((v, i) => {
      const dot = el('i', v > 0 ? 'on' : '');
      if (i % stepsPerBeat === 0) dot.classList.add('beat-start');
      dot.style.setProperty('--v', v);
      row.append(dot);
    });
    return row;
  }

  function renderDetails() {
    const loop = findLoop(selectedId);
    // The save form takes the details' place while it's open.
    $('loop-details').hidden = !loop || !form.hidden;
    if (!loop) return;
    $('loop-name').textContent = loop.name;
    $('loop-meta').textContent = `${loop.folder} · ${loop.bpm} BPM${loop.swing > 50 ? ` · swing ${loop.swing}%` : ''} · ${loop.length} steps`;
    $('loop-description').textContent = loop.description;
    if (previewed === loop) return;
    previewed = loop;
    preview.replaceChildren(
      ...loop.tracks.map((t) => previewRow(colors[t.instrument], t.steps, loop.stepsPerBeat)),
      ...(loop.synths ?? []).map((s) => previewRow(colors[s.preset], noteSteps(s, loop.length), loop.stepsPerBeat)),
    );
  }

  // Open a loop's folder, select it and scroll to it.
  function reveal(id) {
    const folder = id.slice(0, id.indexOf('/'));
    openFolders.add(folder);
    saveOpenFolders();
    selectedId = id;
    selectedFolder = folder;
    renderState();
    tree.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // Called after every sync: mark the loaded loop, and reveal it when it changes (also when
  // Claude loads or saves one).
  function sync(previous) {
    const loop = getState().loop;
    if (loop && library.length && loop.id !== previous?.loop?.id) reveal(loop.id);
    else renderState();
  }

  function loadLoop(id) {
    const loop = findLoop(id);
    act('loadLoop', { id });
    if (loop) toast(`Loaded “${loop.name}”. Ctrl+Z to go back.`, 'info');
  }

  async function moveLoop(id, folderName, index) {
    const loop = findLoop(id);
    const from = findFolder(loop?.folder);
    const to = findFolder(folderName);
    if (!loop || !from || !to) return;
    const at = from.loops.indexOf(loop);
    if (from === to && at === index) return;
    // Show the new order right away; the reload below confirms it.
    from.loops.splice(at, 1);
    to.loops.splice(index, 0, loop);
    openFolders.add(to.name);
    saveOpenFolders();
    render();
    try {
      const moved = await post('move', { id, folder: to.name, index });
      if (selectedId === id) selectedId = moved.id;
    } catch (err) {
      toast(err.message);
    }
    await load();
  }

  tree.addEventListener('click', (e) => {
    const folderRow = e.target.closest('.folder > .tree-row');
    if (folderRow) {
      const name = folderRow.parentElement.dataset.folder;
      if (!openFolders.delete(name)) openFolders.add(name);
      selectedFolder = name;
      saveOpenFolders();
      return renderState();
    }
    const loopRow = e.target.closest('.loop-row');
    if (loopRow) {
      selectedId = loopRow.dataset.id;
      selectedFolder = findLoop(selectedId)?.folder ?? selectedFolder;
      renderState();
    }
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.loop-row');
    if (row) loadLoop(row.dataset.id);
  });
  tree.addEventListener('keydown', (e) => {
    const row = e.target.closest('.loop-row');
    if (!row) return;
    if (e.key === 'Enter') loadLoop(row.dataset.id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const loop = findLoop(row.dataset.id);
      const folder = findFolder(loop.folder);
      const index = folder.loops.indexOf(loop) + (e.key === 'ArrowUp' ? -1 : 1);
      if (index >= 0 && index < folder.loops.length) moveLoop(loop.id, folder.name, index);
    }
  });
  $('loop-load').addEventListener('click', () => selectedId && loadLoop(selectedId));
  $('library-refresh').addEventListener('click', load);

  // --- dragging loops ----------------------------------------------------------

  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.loop-row');
    if (!row) return;
    dragging = row.dataset.id;
    e.dataTransfer.setData(LOOP_TYPE, row.dataset.id);
    e.dataTransfer.effectAllowed = 'copyMove'; // copy onto the sequencer, move within the tree
    row.classList.add('drag-source');
  });

  // Where a loop dragged inside the tree would land: before or after another loop, or at the
  // end of a different folder when it's over that folder's name.
  function targetAt(e) {
    const source = findLoop(dragging);
    const row = e.target.closest?.('.loop-row, .folder > .tree-row, .empty-row');
    if (!source || !row) return null;
    const folder = row.closest('.folder').dataset.folder;
    if (row.matches('.loop-row')) {
      if (row.dataset.id === dragging) return null;
      const rect = row.getBoundingClientRect();
      return { folder, row, after: e.clientY > rect.top + rect.height / 2 };
    }
    return folder === source.folder ? null : { folder, into: true };
  }

  function dropIndex(target) {
    const ids = findFolder(target.folder)
      .loops.map((l) => l.id)
      .filter((id) => id !== dragging);
    return target.into ? ids.length : ids.indexOf(target.row.dataset.id) + (target.after ? 1 : 0);
  }

  function markTarget(target) {
    for (const node of tree.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
      node.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
    if (target?.into) tree.querySelector(`.folder[data-folder="${CSS.escape(target.folder)}"] > .tree-row`).classList.add('drop-into');
    else if (target) target.row.classList.add(target.after ? 'drop-after' : 'drop-before');
  }

  // Holding a loop over a closed folder opens it, like in a file manager.
  function openOnHover(target) {
    const folder = target?.into && !openFolders.has(target.folder) ? target.folder : null;
    if (hover?.folder === folder) return;
    clearTimeout(hover?.timer);
    hover = folder && {
      folder,
      timer: setTimeout(() => {
        openFolders.add(folder);
        saveOpenFolders();
        renderState();
      }, 700),
    };
  }

  tree.addEventListener('dragover', (e) => {
    if (!dragging || !e.dataTransfer.types.includes(LOOP_TYPE)) return;
    const target = targetAt(e);
    markTarget(target);
    openOnHover(target);
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  tree.addEventListener('dragleave', (e) => {
    if (tree.contains(e.relatedTarget)) return;
    markTarget(null);
    openOnHover(null);
  });
  tree.addEventListener('drop', (e) => {
    const target = dragging && targetAt(e);
    markTarget(null);
    openOnHover(null);
    if (!target) return;
    e.preventDefault();
    const id = dragging;
    const index = dropIndex(target);
    dragging = null; // the row is re-rendered, so its dragend may never reach us
    moveLoop(id, target.folder, index);
  });

  // Drag a loop onto the sequencer window to load it.
  sequencerWindow.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(LOOP_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    sequencerWindow.classList.add('drop-target');
  });
  sequencerWindow.addEventListener('dragleave', (e) => {
    if (!sequencerWindow.contains(e.relatedTarget)) sequencerWindow.classList.remove('drop-target');
  });
  sequencerWindow.addEventListener('drop', (e) => {
    sequencerWindow.classList.remove('drop-target');
    const id = e.dataTransfer.getData(LOOP_TYPE);
    if (!id) return;
    e.preventDefault();
    loadLoop(id);
  });
  addEventListener('dragend', () => {
    dragging = null;
    markTarget(null);
    openOnHover(null);
    for (const node of tree.querySelectorAll('.drag-source')) node.classList.remove('drag-source');
    sequencerWindow.classList.remove('drop-target');
  });

  // --- saving the pattern ------------------------------------------------------

  const existingLoop = () => {
    const name = nameInput.value.trim().toLowerCase();
    return findFolder(folderSelect.value)?.loops.find((l) => l.name.toLowerCase() === name) ?? null;
  };

  function updateSaveButton() {
    const existing = existingLoop();
    // Until it's edited, the description is the one of the loop that would be replaced.
    if (!descriptionEdited) descriptionInput.value = existing?.description ?? '';
    submit.textContent = existing ? 'Replace' : 'Save';
    submit.disabled = !nameInput.value.trim() || !folderSelect.value;
    $('save-note').textContent = !library.length
      ? 'Make a folder first with New folder.'
      : existing
        ? `Replaces “${existing.name}” in ${existing.folder}.`
        : 'Saves the tempo, the drums and the piano-roll notes.';
  }

  function fillFolders(preferred = folderSelect.value) {
    folderSelect.replaceChildren(...library.map((f) => new Option(f.name, f.name)));
    folderSelect.value = findFolder(preferred) ? preferred : (library[0]?.name ?? '');
    updateSaveButton();
  }

  // Like "Save as" in a document app: the name of the loop the pattern came from is filled
  // in, so saving it again replaces that loop unless you type a new name.
  function openSave() {
    const loop = getState()?.loop;
    const current = loop && findLoop(loop.id);
    nameInput.value = current?.name ?? loop?.name ?? '';
    descriptionEdited = false;
    fillFolders(selectedFolder ?? current?.folder);
    form.hidden = false;
    $('save-open').setAttribute('aria-expanded', 'true');
    renderDetails();
    nameInput.focus();
    nameInput.select();
  }

  function closeSave() {
    form.hidden = true;
    $('save-open').setAttribute('aria-expanded', 'false');
    renderDetails();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const saved = await post('loops', {
        folder: folderSelect.value,
        name: nameInput.value,
        description: descriptionInput.value,
        overwrite: !!existingLoop(),
      });
      closeSave();
      toast(`Saved “${saved.name}” in ${saved.folder}.`, 'info');
      await load();
      reveal(saved.id);
    } catch (err) {
      toast(err.message);
    } finally {
      updateSaveButton();
    }
  });
  form.addEventListener('input', (e) => {
    if (e.target === descriptionInput) descriptionEdited = true;
    else updateSaveButton();
  });
  form.addEventListener('keydown', (e) => e.key === 'Escape' && closeSave());
  $('save-cancel').addEventListener('click', closeSave);
  $('save-open').addEventListener('click', () => (form.hidden ? openSave() : closeSave()));

  // --- new folders -------------------------------------------------------------

  // An editable row at the top of the tree. Enter or clicking away creates the folder, Escape cancels.
  function startNewFolder() {
    if (newFolderRow) return newFolderRow.querySelector('input').focus();
    const input = el('input', 'tree-input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Folder name';
    input.setAttribute('aria-label', 'New folder name');
    newFolderRow = el('li', 'tree-row new-folder');
    newFolderRow.append(el('span', 'folder-icon'), input);
    tree.prepend(newFolderRow);
    tree.scrollTop = 0;
    input.focus();

    let busy = false;
    const close = () => {
      newFolderRow?.remove();
      newFolderRow = null;
    };
    const create = async (keepOpenOnError) => {
      const name = input.value.trim();
      if (busy) return;
      if (!name) return close();
      busy = true;
      try {
        const folder = await post('folders', { name });
        close();
        openFolders.add(folder.name);
        saveOpenFolders();
        selectedFolder = folder.name;
        await load();
        if (!form.hidden) fillFolders(folder.name);
        tree.querySelector(`.folder[data-folder="${CSS.escape(folder.name)}"]`)?.scrollIntoView({ block: 'nearest' });
      } catch (err) {
        toast(err.message);
        busy = false;
        if (keepOpenOnError) input.select();
        else close();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create(true);
      if (e.key === 'Escape') {
        busy = true;
        close();
      }
    });
    input.addEventListener('blur', () => create(false));
  }

  $('folder-new').addEventListener('click', startNewFolder);

  return { load, sync };
}
