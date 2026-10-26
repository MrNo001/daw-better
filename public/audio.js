// Drum synth and step scheduler built on the Web Audio API. Every sound is synthesized,
// so there are no samples to load. Scheduling uses the look-ahead pattern: a timer wakes
// up often and books the notes due in the next ~120ms on the audio clock, which keeps
// timing tight even when the main thread is busy.

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
// 808-style metallic partials used for hats and cymbals.
const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

// Timers in hidden tabs are throttled to once a second; a worker's aren't, so playback
// keeps going while the user is in another window talking to Claude.
function createTicker(onTick) {
  const source = 'let t; onmessage = (e) => { clearInterval(t); if (e.data) t = setInterval(() => postMessage(0), e.data); };';
  try {
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = onTick;
    return { start: () => worker.postMessage(TICK_MS), stop: () => worker.postMessage(0) };
  } catch {
    let timer;
    return { start: () => (timer = setInterval(onTick, TICK_MS)), stop: () => clearInterval(timer) };
  }
}

export class DrumEngine {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.onStep = null;
    this.queue = [];
    this.openHat = null;
    this.ticker = createTicker(() => this.schedule());
  }

  get ready() {
    return this.ctx?.state === 'running';
  }

  // Must be called from a user gesture the first time (browser autoplay policy).
  async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.ratio.value = 4;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(compressor).connect(ctx.destination);
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ready;
  }

  start(getState) {
    if (!this.ready || this.running) return;
    this.getState = getState;
    this.running = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.05;
    this.queue = [];
    this.current = -1;
    this.schedule();
    this.ticker.start();
    this.raf = requestAnimationFrame(this.draw);
  }

  stop() {
    this.ticker.stop();
    cancelAnimationFrame(this.raf);
    this.running = false;
    this.queue = [];
    this.onStep?.(-1);
  }

  schedule() {
    if (!this.running) return;
    const s = this.getState();
    const swingable = s.stepsPerBeat % 2 === 0;
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      const i = this.step % s.length;
      const stepDur = 60 / s.bpm / s.stepsPerBeat;
      // Swing delays every second step: at 66% the off-beat lands on the triplet.
      const offset = swingable && i % 2 === 1 ? (s.swing / 100 - 0.5) * 2 * stepDur : 0;
      const time = this.nextTime + offset;
      const anySolo = s.tracks.some((t) => t.solo);
      for (const t of s.tracks) {
        const v = t.steps[i];
        if (v > 0 && !t.mute && (!anySolo || t.solo)) this.trigger(t.instrument, time, v * t.volume);
      }
      this.queue.push({ step: i, time });
      this.nextTime += stepDur;
      this.step = i + 1;
    }
  }

  // Moves the playhead in sync with what is actually being heard.
  draw = () => {
    const now = this.ctx.currentTime;
    let step = this.current;
    while (this.queue.length && this.queue[0].time <= now) step = this.queue.shift().step;
    if (step !== this.current) {
      this.current = step;
      this.onStep?.(step);
    }
    if (this.running) this.raf = requestAnimationFrame(this.draw);
  };

  trigger(instrument, time = this.ctx.currentTime, velocity = 0.8) {
    if (!this.ctx || velocity <= 0) return;
    const voice = VOICES[instrument];
    if (voice) voice(this, Math.max(time, this.ctx.currentTime), velocity);
  }

  // --- building blocks -------------------------------------------------------

  envelope(time, peak, decay, destination = this.master) {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    gain.connect(destination);
    return gain;
  }

  osc(type, freq, time, duration, destination) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    osc.connect(destination);
    osc.start(time);
    osc.stop(time + duration + 0.05);
    return osc;
  }

  noise(time, duration, destination) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.connect(destination);
    src.start(time);
    src.stop(time + duration + 0.05);
    return src;
  }

  filter(type, freq, destination, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(destination);
    return f;
  }

  metal(time, peak, decay, highpass) {
    const env = this.envelope(time, peak, decay);
    const hp = this.filter('highpass', highpass, env);
    const bp = this.filter('bandpass', 10000, hp, 0.8);
    for (const ratio of METAL_RATIOS) this.osc('square', 40 * ratio, time, decay, bp);
    return env;
  }

  // A closed hat (or a new open hat) cuts off a ringing open hat, like on a real kit.
  chokeOpenHat(time) {
    if (!this.openHat) return;
    const g = this.openHat.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(time);
    else g.cancelScheduledValues(time);
    g.setTargetAtTime(0.0001, time, 0.008);
    this.openHat = null;
  }
}

function tom(freq) {
  return (e, t, v) => {
    const env = e.envelope(t, v * 0.9, 0.45);
    const osc = e.osc('sine', freq * 1.4, t, 0.45, env);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.1);
    e.noise(t, 0.04, e.filter('lowpass', 2500, e.envelope(t, v * 0.08, 0.04)));
  };
}

const VOICES = {
  kick(e, t, v) {
    const env = e.envelope(t, v * 1.1, 0.5);
    const osc = e.osc('sine', 155, t, 0.5, env);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.14);
    e.osc('triangle', 1200, t, 0.01, e.envelope(t, v * 0.15, 0.012));
  },

  snare(e, t, v) {
    e.noise(t, 0.22, e.filter('highpass', 1500, e.envelope(t, v * 0.55, 0.2)));
    const body = e.osc('triangle', 210, t, 0.12, e.envelope(t, v * 0.5, 0.11));
    body.frequency.exponentialRampToValueAtTime(160, t + 0.1);
  },

  clap(e, t, v) {
    const gain = e.ctx.createGain();
    const g = gain.gain;
    g.setValueAtTime(0.0001, t);
    // Three quick bursts then a tail: the "multiple hands" sound.
    for (const offset of [0, 0.011, 0.022]) {
      g.setValueAtTime(v * 0.8, t + offset);
      g.exponentialRampToValueAtTime(v * 0.15, t + offset + 0.009);
    }
    g.setValueAtTime(v * 0.6, t + 0.033);
    g.exponentialRampToValueAtTime(0.0001, t + 0.22);
    gain.connect(e.master);
    e.noise(t, 0.25, e.filter('bandpass', 1100, gain, 0.8));
  },

  rim(e, t, v) {
    const hp = e.filter('highpass', 400, e.envelope(t, v * 0.45, 0.04));
    e.osc('triangle', 1720, t, 0.04, hp);
    e.osc('square', 820, t, 0.03, e.filter('bandpass', 820, hp, 3));
  },

  closed_hat(e, t, v) {
    e.chokeOpenHat(t);
    e.metal(t, v * 0.32, 0.06, 7500);
  },

  open_hat(e, t, v) {
    e.chokeOpenHat(t);
    e.openHat = e.metal(t, v * 0.3, 0.4, 7000);
  },

  low_tom: tom(95),
  mid_tom: tom(140),
  high_tom: tom(200),

  cowbell(e, t, v) {
    const gain = e.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(v * 0.3, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(v * 0.08, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    gain.connect(e.master);
    const bp = e.filter('bandpass', 1400, gain, 0.7);
    e.osc('square', 540, t, 0.4, bp);
    e.osc('square', 800, t, 0.4, bp);
  },

  crash(e, t, v) {
    e.metal(t, v * 0.25, 1.6, 5000);
    e.noise(t, 1.4, e.filter('highpass', 6000, e.envelope(t, v * 0.2, 1.4)));
  },
};
