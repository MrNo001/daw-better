// Rotary knob: drag up/down (hold Shift for fine control), scroll, or use the arrow keys.
// Double-click resets to the default value.

export function createKnob({ min = 0, max = 1, step = 0, value = min, defaultValue = value, size = 'md', label, format = String, onInput }) {
  const el = document.createElement('div');
  el.className = `knob knob-${size}`;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', min);
  el.setAttribute('aria-valuemax', max);
  el.innerHTML = '<div class="knob-cap"><div class="knob-mark"></div></div>';

  let current = value;
  let dragging = false;
  let disabled = false;

  const quantize = (v) => {
    const clamped = Math.min(max, Math.max(min, v));
    return step ? Math.round((clamped - min) / step) * step + min : clamped;
  };

  function render() {
    el.style.setProperty('--p', (current - min) / (max - min));
    el.dataset.value = format(current);
    el.setAttribute('aria-valuenow', current);
    el.setAttribute('aria-valuetext', format(current));
    el.title = `${label}: ${format(current)}`;
  }

  function update(v) {
    if (disabled) return;
    const next = quantize(v);
    if (next === current) return;
    current = next;
    render();
    onInput?.(current);
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || disabled) return;
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    dragging = true;
    el.classList.add('active');
    const startY = e.clientY;
    const startValue = current;
    const move = (ev) => update(startValue + ((startY - ev.clientY) / (ev.shiftKey ? 600 : 150)) * (max - min));
    const end = () => {
      dragging = false;
      el.classList.remove('active');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      update(current - Math.sign(e.deltaY) * Math.max(step, (max - min) / 50));
    },
    { passive: false },
  );

  el.addEventListener('dblclick', () => update(defaultValue));

  el.addEventListener('keydown', (e) => {
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!direction) return;
    e.preventDefault();
    update(current + direction * Math.max(step, (max - min) / 100) * (e.shiftKey ? 5 : 1));
  });

  render();

  return {
    el,
    set(v) {
      if (dragging) return;
      current = quantize(v);
      render();
    },
    setDisabled(value) {
      disabled = value;
      el.classList.toggle('disabled', value);
      el.setAttribute('aria-disabled', value);
    },
  };
}
