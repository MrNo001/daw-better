// The Mixer window: a strip for every mixer channel (see shared/mixer.js), with its effects,
// pan, mute and solo, fader and level meter, then the master strip. The selected channel's
// effects are shown as cards with knobs. Edits go to the server like every other edit; the
// meters read the audio engine directly.

import { EFFECTS, MAX_EFFECTS, VOLUME_RANGE, defaultChannel, effectType, formatParam, mixerChannels, toPosition, fromPosition } from '/shared/mixer.js';
import { createKnob } from './knob.js';
import { byId as $, requestFrame } from './views.js';

const MASTER = 'master';
const MASTER_COLOR = '#e4e7ee';
const SLOTS = 2; // effect names a strip has room for

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Fader law: 0 dB sits three quarters of the way up and +6 dB at the top. Below 0 dB the
// scale stretches like a mixing desk's: -6 dB is about halfway, -24 dB a fifth of the way.
const ZERO = 0.75;
const BOTTOM = ZERO * 10 ** (VOLUME_RANGE[0] / 40);
export function faderPosition(db) {
  if (db <= VOLUME_RANGE[0]) return 0;
  return db >= 0 ? ZERO + (db / VOLUME_RANGE[1]) * (1 - ZERO) : ZERO * 10 ** (db / 40);
}
export function faderDb(position) {
  if (position <= BOTTOM) return VOLUME_RANGE[0];
  const db = position >= ZERO ? ((position - ZERO) / (1 - ZERO)) * VOLUME_RANGE[1] : 40 * Math.log10(position / ZERO);
  return Math.round(Math.min(VOLUME_RANGE[1], db) * 10) / 10;
}

const dbText = (db) => (db <= VOLUME_RANGE[0] ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
const panText = (pan) => (pan === 0 ? 'C' : `${Math.abs(pan)}${pan < 0 ? 'L' : 'R'}`);

// A vertical fader with a level meter beside it, on the same scale so the meter's 0 dB lines
// up with the fader's. Drag it (Shift for fine moves), scroll it, or use the arrow keys;
// double-click goes back to 0 dB.
function createFader({ label, onInput }) {
  const root = el('div', 'fader-box');
  const meter = el('div', 'meter');
  const mask = el('div', 'meter-mask');
  const hold = el('div', 'meter-peak');
  meter.append(mask, hold);
  const track = el('div', 'fader');
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuemin', VOLUME_RANGE[0]);
  track.setAttribute('aria-valuemax', VOLUME_RANGE[1]);
  const cap = el('div', 'fader-cap');
  track.append(el('div', 'fader-slot'), el('div', 'fader-zero'), cap);
  root.append(meter, track);

  let value = 0;
  let dragging = false;
  const render = () => {
    track.style.setProperty('--p', faderPosition(value));
    track.setAttribute('aria-valuenow', value);
    track.setAttribute('aria-valuetext', `${dbText(value)} dB`);
    track.title = `${label}: ${dbText(value)} dB`;
  };
  const update = (db) => {
    const next = Math.round(Math.min(VOLUME_RANGE[1], Math.max(VOLUME_RANGE[0], db)) * 10) / 10;
    if (next === value) return;
    value = next;
    render();
    onInput(value);
  };

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.focus();
    track.setPointerCapture(e.pointerId);
    dragging = true;
    track.classList.add('active');
    const startY = e.clientY;
    const start = faderPosition(value);
    const travel = track.clientHeight - cap.offsetHeight;
    const move = (ev) => update(faderDb(start + ((startY - ev.clientY) / travel) * (ev.shiftKey ? 0.2 : 1)));
    const end = () => {
      dragging = false;
      track.classList.remove('active');
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  });
  track.addEventListener('dblclick', () => update(0));
  track.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      update(value <= VOLUME_RANGE[0] && e.deltaY < 0 ? -40 : value - Math.sign(e.deltaY) * 0.5);
    },
    { passive: false },
  );
  track.addEventListener('keydown', (e) => {
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!direction) return;
    e.preventDefault();
    update(value + direction * (e.shiftKey ? 3 : 0.5));
  });

  // The meter falls back smoothly and keeps its peak for a second. `level` is 0-1 full scale.
  let shown = 0;
  let peak = 0;
  let peakAt = 0;
  let clipAt = 0;
  let drawn = '';
  render();
  return {
    el: root,
    set(db) {
      if (dragging) return;
      value = db;
      render();
    },
    level(level, now, dt) {
      const position = level > 0 ? faderPosition(20 * Math.log10(level)) : 0;
      shown = Math.max(position, shown - dt * 1.2);
      if (shown >= peak || now - peakAt > 1000) {
        peak = shown;
        peakAt = now;
      }
      if (level >= 1) clipAt = now;
      const clip = now - clipAt < 1500;
      // Only touch the page when the meter has moved, so a still meter costs nothing.
      const frame = `${shown.toFixed(3)} ${peak.toFixed(3)} ${clip}`;
      if (frame === drawn) return;
      drawn = frame;
      mask.style.height = `${(1 - shown) * 100}%`;
      hold.style.bottom = `${peak * 100}%`;
      hold.hidden = peak <= 0.01;
      meter.classList.toggle('clip', clip);
    },
  };
}

export function createMixer({ engine, act, getState }) {
  const strips = $('mixer-strips');
  const list = $('fx-list');
  const add = $('fx-add');
  const win = $('win-mixer');
  const rows = new Map(); // channel id -> strip parts
  let cards = new Map(); // effect id -> card parts
  let stripSignature = '';
  let rackSignature = '';
  let rackChannel = null;
  let selectedId = null;
  let revealEffect = null;

  for (const type of EFFECTS) add.append(new Option(`${type.name} · ${type.hint}`, type.id));

  const settingsOf = (state, id) => (id === MASTER ? state.mixer.master : (state.mixer.channels[id] ?? defaultChannel()));
  const channelList = (state) => [...mixerChannels(state), { id: MASTER, name: 'Master', color: MASTER_COLOR, here: true }];

  // Scroll a strip or card into view inside its own list. (scrollIntoView could also scroll
  // the workspace, which hides its overflow, and shift every window.)
  function reveal(node, box, horizontal) {
    if (horizontal) {
      const left = node.offsetLeft - box.offsetLeft;
      if (left < box.scrollLeft) box.scrollLeft = left;
      else if (left + node.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + node.offsetWidth - box.clientWidth;
    } else {
      const top = node.offsetTop - box.offsetTop;
      if (top < box.scrollTop || top + node.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top;
    }
  }

  // --- strips ------------------------------------------------------------------

  function buildStrip(channel) {
    const id = channel.id;
    const master = id === MASTER;
    const strip = el('div', master ? 'strip master' : 'strip');
    strip.dataset.channel = id;
    strip.style.setProperty('--c', channel.color);
    const name = el('button', 'strip-name', channel.name);
    const fx = el('ul', 'strip-fx');
    const parts = { strip, name, fx, fxSignature: null };

    if (master) {
      strip.append(name, fx, el('div', 'strip-controls'));
    } else {
      parts.pan = createKnob({
        min: -100,
        max: 100,
        step: 1,
        value: 0,
        defaultValue: 0,
        size: 'sm',
        bipolar: true,
        label: `${channel.name} pan`,
        format: panText,
        onInput: (pan) => act('setChannel', { channel: id, pan }, `pan:${id}`),
      });
      parts.pan.el.style.setProperty('--arc', channel.color);
      parts.mute = el('button', 'mute-led');
      parts.solo = el('button', 'solo-btn', 'S');
      parts.solo.title = 'Solo: hear only the soloed channels';
      const controls = el('div', 'strip-controls');
      controls.append(parts.mute, parts.pan.el, parts.solo);
      strip.append(name, fx, controls);
    }
    parts.fader = createFader({
      label: `${channel.name} level`,
      onInput: (volume) => act('setChannel', { channel: id, volume }, `fader:${id}`),
    });
    parts.db = el('output', 'strip-db');
    strip.append(parts.fader.el, parts.db);
    return parts;
  }

  function renderStrips(state, channels) {
    const signature = JSON.stringify(channels.map((c) => [c.id, c.name, c.color]));
    if (signature !== stripSignature) {
      stripSignature = signature;
      rows.clear();
      strips.replaceChildren(
        ...channels.map((c) => {
          const parts = buildStrip(c);
          rows.set(c.id, parts);
          if (c.id !== MASTER) return parts.strip;
          // The master stays in view; the other strips scroll under it.
          const dock = el('div', 'master-dock');
          dock.append(parts.strip);
          return dock;
        }),
      );
    }
    const anySolo = channels.some((c) => c.id !== MASTER && settingsOf(state, c.id).solo);
    for (const c of channels) {
      const s = settingsOf(state, c.id);
      const r = rows.get(c.id);
      r.strip.classList.toggle('selected', c.id === selectedId);
      r.strip.classList.toggle('away', !c.here);
      r.name.title = c.here ? `${c.name}: show its effects` : `${c.name} (not in this pattern): show its effects`;
      r.fader.set(s.volume);
      r.db.value = dbText(s.volume);
      if (c.id !== MASTER) {
        r.strip.classList.toggle('silent', s.mute || (anySolo && !s.solo));
        r.pan.set(s.pan);
        r.mute.classList.toggle('muted', s.mute);
        r.mute.setAttribute('aria-pressed', s.mute);
        r.mute.title = s.mute ? 'Unmute' : 'Mute';
        r.solo.classList.toggle('on', s.solo);
        r.solo.setAttribute('aria-pressed', s.solo);
      }
      // The effect slots: short names, faded when bypassed. Past two, "+N" stands for the rest.
      const fxSignature = JSON.stringify(s.effects.map((e) => [e.id, e.type, e.on]));
      if (fxSignature !== r.fxSignature) {
        r.fxSignature = fxSignature;
        const shown = s.effects.length > SLOTS ? s.effects.slice(0, SLOTS - 1) : s.effects;
        const items = shown.map((e) => {
          const item = el('li', e.on ? 'fx-slot' : 'fx-slot off', effectType(e.type).short);
          item.dataset.effect = e.id;
          item.title = `${effectType(e.type).name}${e.on ? '' : ' (off)'}`;
          return item;
        });
        const rest = s.effects.slice(shown.length);
        if (rest.length) {
          const more = el('li', 'fx-slot more', `+${rest.length}`);
          more.dataset.effect = rest[0].id;
          more.title = rest.map((e) => `${effectType(e.type).name}${e.on ? '' : ' (off)'}`).join(', ');
          items.push(more);
        }
        r.fx.replaceChildren(...items);
      }
    }
  }

  // --- effect cards ------------------------------------------------------------

  function buildCard(channelId, effect) {
    const type = effectType(effect.type);
    const card = el('section', 'fx-card');
    card.dataset.effect = effect.id;
    const head = el('header', 'fx-head');
    const power = el('button', 'fx-power');
    const name = el('h4', 'fx-name', type.name);
    const up = el('button', 'fx-move', '↑');
    up.dataset.move = -1;
    up.title = 'Move up: earlier in the chain';
    up.setAttribute('aria-label', `Move ${type.name} up`);
    const down = el('button', 'fx-move', '↓');
    down.dataset.move = 1;
    down.title = 'Move down: later in the chain';
    down.setAttribute('aria-label', `Move ${type.name} down`);
    const remove = el('button', 'fx-rm', '×');
    remove.title = `Remove ${type.name}`;
    remove.setAttribute('aria-label', `Remove ${type.name}`);
    head.append(power, name, up, down, remove);
    const about = el('p', 'fx-about', type.about);
    about.title = type.about;
    const controls = el('div', 'fx-controls');
    card.append(head, about, controls);

    const update = (param, value) =>
      act('updateEffect', { channel: channelId, effect: effect.id, params: { [param.id]: value } }, `fx:${effect.id}:${param.id}`);
    const params = new Map();
    for (const param of type.params) {
      const control = el('label', 'fx-param');
      const caption = el('span', 'fx-label', param.name);
      if (param.options) {
        const select = el('select', 'fx-choice');
        for (const [id, label] of param.options) select.append(new Option(label, id));
        select.setAttribute('aria-label', `${type.name} ${param.name}`);
        select.addEventListener('change', () => update(param, select.value));
        control.classList.add('choice');
        control.append(caption, select);
        params.set(param.id, { select });
      } else {
        const out = el('output', 'fx-value');
        let sent = null;
        const knob = createKnob({
          min: 0,
          max: 1,
          value: toPosition(param, effect.params[param.id]),
          defaultValue: toPosition(param, param.default),
          label: `${type.name} ${param.name}`,
          format: (p) => formatParam(param, fromPosition(param, p)),
          onInput: (p) => {
            const value = fromPosition(param, p);
            if (value === sent) return;
            sent = value;
            out.value = formatParam(param, value);
            update(param, value);
          },
        });
        control.append(knob.el, caption, out);
        params.set(param.id, { knob, out, param });
      }
      controls.append(control);
    }
    let gr = null;
    if (effect.type === 'compressor') {
      gr = el('div', 'fx-gr');
      gr.title = 'Gain reduction: how much the compressor is turning the sound down right now';
      gr.append(el('span', 'fx-gr-label', 'Reduction'), el('span', 'fx-gr-bar'), el('output', 'fx-gr-value', '0 dB'));
      card.append(gr);
    }
    return { card, power, up, down, remove, params, gr };
  }

  function renderRack(state, channel) {
    const s = settingsOf(state, channel.id);
    $('fx-title').textContent = channel.name;
    $('fx-panel').style.setProperty('--c', channel.color);
    add.disabled = s.effects.length >= MAX_EFFECTS;
    add.title = add.disabled ? `A channel holds at most ${MAX_EFFECTS} effects` : `Add an effect to ${channel.name}`;
    const signature = JSON.stringify([channel.id, s.effects.map((e) => [e.id, e.type])]);
    if (signature !== rackSignature) {
      rackSignature = signature;
      // An effect that just appeared on the same channel (added here or by Claude) gets shown.
      const fresh = s.effects.filter((e) => !cards.has(e.id));
      if (rackChannel === channel.id && fresh.length === 1) revealEffect ??= fresh[0].id;
      rackChannel = channel.id;
      cards = new Map(s.effects.map((e) => [e.id, buildCard(channel.id, e)]));
      if (s.effects.length) list.replaceChildren(...[...cards.values()].map((c) => c.card));
      else {
        const b = (text) => el('b', '', text);
        const empty = el('p', 'fx-empty');
        empty.append('No effects on ', b(channel.name), ' yet. Add one with ', b('+ Effect'), ': an ', b('EQ'), ' to shape the tone, a ');
        empty.append(b('Compressor'), ' for punch, ', b('Reverb'), ' for space.');
        list.replaceChildren(empty);
      }
    }
    s.effects.forEach((e, i) => {
      const c = cards.get(e.id);
      c.card.classList.toggle('off', !e.on);
      c.power.setAttribute('aria-pressed', e.on);
      c.power.title = e.on ? 'Turn off (bypass)' : 'Turn on';
      c.power.setAttribute('aria-label', `${effectType(e.type).name} ${e.on ? 'on' : 'off'}`);
      c.up.disabled = i === 0;
      c.down.disabled = i === s.effects.length - 1;
      for (const [id, control] of c.params) {
        if (control.select) control.select.value = e.params[id];
        else {
          control.knob.set(toPosition(control.param, e.params[id]));
          control.out.value = formatParam(control.param, e.params[id]);
        }
      }
    });
    if (revealEffect && cards.has(revealEffect)) {
      const card = cards.get(revealEffect).card;
      reveal(card, list);
      flash(card);
      revealEffect = null;
    }
  }

  function flash(node) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
  }

  // --- render ------------------------------------------------------------------

  function render(previous, source) {
    const state = getState();
    if (!state) return;
    const channels = channelList(state);
    // Follow Claude to the channel it changed, and point out what changed.
    const changed =
      previous && source === 'claude'
        ? channels.filter((c) => JSON.stringify(settingsOf(state, c.id)) !== JSON.stringify(settingsOf(previous, c.id)))
        : [];
    if (changed.length && !changed.some((c) => c.id === selectedId)) selectedId = changed[0].id;
    if (!channels.some((c) => c.id === selectedId)) selectedId = (channels.find((c) => c.here) ?? channels[0]).id;

    renderStrips(state, channels);
    renderRack(state, channels.find((c) => c.id === selectedId));
    for (const c of changed) flash(rows.get(c.id).strip);
    const effects = channels.reduce((n, c) => n + settingsOf(state, c.id).effects.length, 0);
    $('mixer-meta').textContent = `${channels.length - 1} channels · ${effects} effect${effects === 1 ? '' : 's'}`;
  }

  function select(id, effectId) {
    if (!rows.has(id)) return;
    selectedId = id;
    revealEffect = effectId ?? null;
    render();
    if (id !== MASTER) reveal(rows.get(id).strip, strips, true);
  }

  // --- input -------------------------------------------------------------------

  strips.addEventListener('click', (e) => {
    const strip = e.target.closest('.strip');
    if (!strip) return;
    const id = strip.dataset.channel;
    const s = settingsOf(getState(), id);
    if (e.target.closest('.mute-led')) return act('setChannel', { channel: id, mute: !s.mute });
    if (e.target.closest('.solo-btn')) return act('setChannel', { channel: id, solo: !s.solo });
    if (e.target.closest('.fader, .knob')) return;
    select(id, e.target.closest('.fx-slot')?.dataset.effect);
  });

  add.addEventListener('change', () => {
    if (add.value) act('addEffect', { channel: selectedId, type: add.value });
    add.value = '';
  });

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.fx-card');
    if (!card) return;
    const effects = settingsOf(getState(), selectedId).effects;
    const index = effects.findIndex((x) => x.id === card.dataset.effect);
    const effect = effects[index];
    if (!effect) return;
    const ref = { channel: selectedId, effect: effect.id };
    if (e.target.closest('.fx-power')) act('updateEffect', { ...ref, on: !effect.on });
    else if (e.target.closest('.fx-rm')) act('removeEffect', ref);
    else if (e.target.closest('.fx-move')) act('moveEffect', { ...ref, index: index + Number(e.target.closest('.fx-move').dataset.move) });
  });

  // --- meters ------------------------------------------------------------------

  let last = performance.now();
  function meter(now) {
    requestFrame(meter);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (win.classList.contains('collapsed')) return;
    const levels = engine.levels();
    for (const [id, r] of rows) r.fader.level(levels ? (id === MASTER ? levels.master : (levels.channels[id] ?? 0)) : 0, now, dt);
    for (const [id, c] of cards) {
      if (!c.gr) continue;
      const reduction = Math.min(0, levels?.reductions[id] ?? 0);
      const text = `${reduction > -0.05 ? '0' : reduction.toFixed(1)} dB`;
      if (text === c.grText) continue;
      c.grText = text;
      c.gr.style.setProperty('--r', Math.min(1, -reduction / 24));
      c.gr.querySelector('output').value = text;
    }
  }
  requestFrame(meter);

  return { render, select };
}
