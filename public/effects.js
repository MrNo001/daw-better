// The mixer's sound: channel strips and effects on the Web Audio API (the settings themselves
// are described in shared/mixer.js).
//
// A strip is   input → effect → effect → … → pan → fader → the master strip's input,
// with a meter after the fader; from the pan on, it's stereo. Every track's voices play into
// its channel's strip, and the
// master strip feeds the engine's output. Each effect can be bypassed: its sound fades out
// and the input passes straight through.

import { DELAY_TIMES, defaultChannel, dbToGain, mixerChannels } from '/shared/mixer.js';

// Parameter changes glide over a few milliseconds; jumping would click.
const SMOOTH = 0.015;
const targets = new WeakMap();

// Set an AudioParam, only when its target changes. The first value is set straight away.
function glide(ctx, param, value, time = SMOOTH) {
  if (targets.get(param) === value) return;
  if (targets.has(param)) param.setTargetAtTime(value, ctx.currentTime, time);
  else param.setValueAtTime(value, ctx.currentTime);
  targets.set(param, value);
}

function biquad(ctx, type, frequency, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  if (q !== undefined) f.Q.value = q;
  return f;
}

// For low-pass and high-pass filters the Web Audio Q is a resonance in dB; -3 dB is flat.
const FLAT = -3;

// The Mix setting: up to 50% the effect is added on top of the full dry sound, past that the
// dry sound fades out, leaving only the effect at 100%. Connect the effect's sound to `wet`.
function wetDry(ctx, input, output) {
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  return {
    wet,
    mix(value) {
      glide(ctx, dry.gain, Math.min(1, 2 * (1 - value)));
      glide(ctx, wet.gain, Math.min(1, 2 * value));
    },
  };
}

// --- distortion curves ---------------------------------------------------------------

const CURVE_SIZE = 4096;

// `amount` is 0-1. Warm and fuzz push the signal up to +30 dB into a soft or a hard,
// lopsided clipper and turn the result back down to about the same loudness; crush rounds
// the signal to fewer and fewer levels, from 128 down to 1.4 each side of zero.
export function driveCurve(mode, amount) {
  const curve = new Float32Array(CURVE_SIZE);
  const drive = 10 ** (amount * 1.5);
  const levels = 2 ** (7 - amount * 6.5);
  const hard = (u) => u / (1 + Math.abs(u) ** 6) ** (1 / 6);
  const bias = 0.3 * amount;
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = (i / (CURVE_SIZE - 1)) * 2 - 1;
    if (mode === 'crush') curve[i] = Math.round(x * levels) / levels;
    else if (mode === 'fuzz') curve[i] = (hard(drive * x + bias) - hard(bias)) / Math.sqrt(drive);
    else curve[i] = Math.tanh(drive * x) / Math.sqrt(drive);
  }
  return curve;
}

// --- reverb impulse responses --------------------------------------------------------

// A room's response to a click: noise dying away by 60 dB over `decay` seconds and losing
// its highs as it fades (sooner when the tone is dark), with different noise in each ear.
function impulse(ctx, decay, tone) {
  const rate = ctx.sampleRate;
  const length = Math.round(rate * (decay * 1.2 + 0.05));
  const buffer = ctx.createBuffer(2, length, rate);
  const bright = 2500 * 8 ** (tone / 100);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    let a = 1;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      if (i % 64 === 0) {
        const cutoff = Math.min(rate * 0.45, 200 + bright * Math.exp((-3 * t) / decay));
        a = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
      }
      low += a * (Math.random() * 2 - 1 - low);
      data[i] = low * Math.exp((-6.9 * t) / decay) * Math.min(1, t / 0.002);
    }
  }
  return buffer;
}

// --- effects -------------------------------------------------------------------------

// Each builder wires input → … → output and returns update(params, bpm), and optionally
// dispose() and reduction() (the compressor's gain reduction in dB, for its meter).
const BUILDERS = {
  eq(ctx, input, output) {
    const low = biquad(ctx, 'lowshelf', 120);
    const mid = biquad(ctx, 'peaking', 1000, 0.9);
    const high = biquad(ctx, 'highshelf', 7000);
    input.connect(low).connect(mid).connect(high).connect(output);
    return {
      update(p) {
        glide(ctx, low.gain, p.low);
        glide(ctx, mid.gain, p.mid);
        glide(ctx, mid.frequency, p.freq);
        glide(ctx, high.gain, p.high);
      },
    };
  },

  // The Web Audio compressor turns its output back up by part of what it takes away, so
  // compressing doesn't simply make things quieter; Gain adjusts the level on top of that.
  compressor(ctx, input, output) {
    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 6;
    const gain = ctx.createGain();
    input.connect(comp).connect(gain).connect(output);
    return {
      update(p) {
        glide(ctx, comp.threshold, p.threshold);
        glide(ctx, comp.ratio, p.ratio);
        glide(ctx, comp.attack, p.attack / 1000);
        glide(ctx, comp.release, p.release / 1000);
        glide(ctx, gain.gain, dbToGain(p.gain));
      },
      // Older browsers expose the reduction as an AudioParam.
      reduction: () => (typeof comp.reduction === 'number' ? comp.reduction : (comp.reduction?.value ?? 0)),
    };
  },

  drive(ctx, input, output) {
    const { wet, mix } = wetDry(ctx, input, output);
    const shaper = ctx.createWaveShaper();
    const dc = biquad(ctx, 'highpass', 15, FLAT); // the lopsided fuzz curve adds an offset
    const tone = biquad(ctx, 'lowpass', 5000, FLAT);
    input.connect(shaper).connect(dc).connect(tone).connect(wet);
    let shape = '';
    return {
      update(p) {
        if (shape !== `${p.mode}:${p.amount}`) {
          shape = `${p.mode}:${p.amount}`;
          shaper.curve = driveCurve(p.mode, p.amount / 100);
          // Crushing is meant to sound rough; the others are oversampled to keep them clean.
          shaper.oversample = p.mode === 'crush' ? 'none' : '4x';
        }
        glide(ctx, tone.frequency, 800 * 22.5 ** (p.tone / 100));
        mix(p.mix / 100);
      },
    };
  },

  filter(ctx, input, output) {
    const f = biquad(ctx, 'lowpass', 2000);
    input.connect(f).connect(output);
    return {
      update(p) {
        f.type = p.mode;
        glide(ctx, f.frequency, p.cutoff);
        // Low- and high-pass resonance runs from flat to a +18 dB peak; band-pass narrows the band.
        glide(ctx, f.Q, p.mode === 'bandpass' ? 0.5 * 40 ** (p.resonance / 100) : FLAT + (p.resonance / 100) * 21);
      },
    };
  },

  // Two delay lines. Mono: the left one repeats itself and both ears hear it. Ping-pong: each
  // echo crosses to the other side, so the echoes bounce between left and right.
  delay(ctx, input, output) {
    const { wet, mix } = wetDry(ctx, input, output);
    const mono = ctx.createGain();
    Object.assign(mono, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const left = ctx.createDelay(4);
    const right = ctx.createDelay(4);
    const toneL = biquad(ctx, 'lowpass', 5000, FLAT);
    const toneR = biquad(ctx, 'lowpass', 5000, FLAT);
    const self = ctx.createGain();
    const cross = ctx.createGain();
    const back = ctx.createGain();
    const spread = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    input.connect(mono).connect(left).connect(toneL);
    toneL.connect(self).connect(left);
    toneL.connect(cross).connect(right).connect(toneR);
    toneR.connect(back).connect(left);
    toneL.connect(merger, 0, 0);
    toneL.connect(spread).connect(merger, 0, 1);
    toneR.connect(merger, 0, 1);
    merger.connect(wet);
    return {
      update(p, bpm) {
        const beats = DELAY_TIMES.find((t) => t.id === p.time)?.beats ?? 0.75;
        const seconds = Math.min(4, (beats * 60) / bpm);
        // A slower glide: a tempo change bends the echoes like a tape delay.
        glide(ctx, left.delayTime, seconds, 0.05);
        glide(ctx, right.delayTime, seconds, 0.05);
        const feedback = p.feedback / 100;
        const ping = p.mode === 'pingpong';
        glide(ctx, self.gain, ping ? 0 : feedback);
        glide(ctx, cross.gain, ping ? feedback : 0);
        glide(ctx, back.gain, ping ? feedback : 0);
        glide(ctx, spread.gain, ping ? 0 : 1);
        for (const tone of [toneL, toneR]) glide(ctx, tone.frequency, 500 * 32 ** (p.tone / 100));
        mix(p.mix / 100);
      },
    };
  },

  // A convolution reverb. A new decay or tone makes a new impulse response, at most a few
  // times a second while a knob turns, and crossfades to it so the tail doesn't cut off.
  // The convolver evens out the power of every response, which leaves these short rooms
  // quiet; +3 dB brings the reverb alone (mix 100%) close to the dry sound's loudness.
  reverb(ctx, input, output) {
    const loudness = Math.SQRT2;
    const { wet, mix } = wetDry(ctx, input, output);
    let current = null;
    let shape = '';
    let pending = null;
    let timer = null;
    const timers = new Set();
    const swap = ({ decay, tone }) => {
      const conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, decay, tone);
      const fade = ctx.createGain();
      fade.gain.value = 0;
      input.connect(conv).connect(fade).connect(wet);
      fade.gain.setTargetAtTime(loudness, ctx.currentTime, 0.03);
      const old = current;
      current = { conv, fade };
      if (!old) return;
      old.fade.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      const t = setTimeout(() => {
        timers.delete(t);
        input.disconnect(old.conv);
        old.fade.disconnect();
      }, 400);
      timers.add(t);
    };
    const flush = () => {
      timer = pending ? setTimeout(flush, 150) : null;
      if (pending) swap(pending);
      pending = null;
    };
    return {
      update(p) {
        mix(p.mix / 100);
        if (shape === `${p.decay}:${p.tone}`) return;
        shape = `${p.decay}:${p.tone}`;
        pending = p;
        if (!timer) flush();
      },
      dispose() {
        clearTimeout(timer);
        for (const t of timers) clearTimeout(t);
      },
    };
  },

  // Two copies, 12 and 18 ms late, drift back and forth with a slow LFO in opposite
  // directions, one in each ear.
  chorus(ctx, input, output) {
    const { wet, mix } = wetDry(ctx, input, output);
    const left = ctx.createDelay(0.1);
    const right = ctx.createDelay(0.1);
    left.delayTime.value = 0.012;
    right.delayTime.value = 0.018;
    const lfo = ctx.createOscillator();
    const depthL = ctx.createGain();
    const depthR = ctx.createGain();
    lfo.connect(depthL).connect(left.delayTime);
    lfo.connect(depthR).connect(right.delayTime);
    lfo.start();
    const merger = ctx.createChannelMerger(2);
    input.connect(left).connect(merger, 0, 0);
    input.connect(right).connect(merger, 0, 1);
    merger.connect(wet);
    return {
      update(p) {
        glide(ctx, lfo.frequency, p.rate);
        const depth = (p.depth / 100) * 0.005;
        glide(ctx, depthL.gain, depth);
        glide(ctx, depthR.gain, -depth);
        mix(p.mix / 100);
      },
      dispose: () => lfo.stop(),
    };
  },
};

// One effect with its bypass: on, the input goes through the effect; off, straight past it.
class Effect {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.through = ctx.createGain();
    this.sound = ctx.createGain();
    this.input.connect(this.through).connect(this.output);
    this.sound.connect(this.output);
    this.body = BUILDERS[type](ctx, this.input, this.sound);
  }

  update(effect, bpm) {
    this.body.update(effect.params, bpm);
    glide(this.ctx, this.sound.gain, effect.on ? 1 : 0, 0.01);
    glide(this.ctx, this.through.gain, effect.on ? 0 : 1, 0.01);
  }

  dispose() {
    this.body.dispose?.();
    this.input.disconnect();
    this.output.disconnect();
  }
}

export class Strip {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    // Pan turns one side down and the other up. A mono sound is spread to both sides first,
    // so the middle leaves the level alone whether or not an effect has made it stereo (a
    // StereoPannerNode drops a mono sound by 3 dB in the middle, but not a stereo one).
    this.pan = ctx.createGain();
    Object.assign(this.pan, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.left = ctx.createGain();
    this.right = ctx.createGain();
    this.pan.connect(split);
    split.connect(this.left, 0).connect(merge, 0, 0);
    split.connect(this.right, 1).connect(merge, 0, 1);
    this.fader = ctx.createGain();
    merge.connect(this.fader).connect(destination);
    // A meter on each side, so a sound panned to one side shows its real peak.
    const sides = ctx.createChannelSplitter(2);
    this.fader.connect(sides);
    this.meters = [0, 1].map((side) => {
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;
      sides.connect(meter, side);
      return meter;
    });
    this.samples = new Float32Array(1024);
    this.input.connect(this.pan);
    this.effects = new Map(); // by effect id
    this.chain = [];
  }

  /** Apply a channel's settings; `gain` is the fader's level, already 0 when muted. */
  sync(settings, gain, bpm) {
    const ids = new Set(settings.effects.map((e) => e.id));
    for (const [id, effect] of this.effects) {
      if (!ids.has(id)) {
        effect.dispose();
        this.effects.delete(id);
      }
    }
    const chain = settings.effects.map((e) => {
      let effect = this.effects.get(e.id);
      if (!effect) this.effects.set(e.id, (effect = new Effect(this.ctx, e.type)));
      effect.update(e, bpm);
      return effect;
    });
    if (chain.length !== this.chain.length || chain.some((effect, i) => effect !== this.chain[i])) {
      this.chain = chain;
      this.rewire();
    }
    // Constant power: both sides at full level in the middle, one side √2 (+3 dB) at the edge.
    const angle = ((settings.pan ?? 0) / 100 + 1) * (Math.PI / 4);
    glide(this.ctx, this.left.gain, Math.SQRT2 * Math.cos(angle));
    glide(this.ctx, this.right.gain, Math.SQRT2 * Math.sin(angle));
    glide(this.ctx, this.fader.gain, gain);
  }

  rewire() {
    this.input.disconnect();
    for (const effect of this.chain) effect.output.disconnect();
    let last = this.input;
    for (const effect of this.chain) {
      last.connect(effect.input);
      last = effect.output;
    }
    last.connect(this.pan);
  }

  /** The loudest sample of the last ~20 ms after the fader, on either side (1 is full scale). */
  peak() {
    let peak = 0;
    for (const meter of this.meters) {
      meter.getFloatTimeDomainData(this.samples);
      for (const v of this.samples) peak = Math.max(peak, Math.abs(v));
    }
    return peak;
  }

  dispose() {
    for (const effect of this.effects.values()) effect.dispose();
    this.input.disconnect();
    this.fader.disconnect();
  }
}

export class Mixer {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.master = new Strip(ctx, output);
    this.strips = new Map(); // by channel (track) id
  }

  /** Where a track's voices play: its channel's strip, made on first use. Without an id, the master. */
  input(id) {
    if (id === undefined) return this.master.input;
    let strip = this.strips.get(id);
    if (!strip) {
      this.strips.set(id, (strip = new Strip(this.ctx, this.master.input)));
      strip.sync(defaultChannel(), 1, 120);
    }
    return strip.input;
  }

  sync(state) {
    const { channels, master } = state.mixer;
    const ids = mixerChannels(state).map((c) => c.id);
    const anySolo = ids.some((id) => channels[id]?.solo);
    for (const id of ids) {
      const settings = channels[id] ?? defaultChannel();
      const audible = !settings.mute && (!anySolo || settings.solo);
      this.input(id);
      this.strips.get(id).sync(settings, audible ? dbToGain(settings.volume) : 0, state.bpm);
    }
    for (const [id, strip] of this.strips) {
      if (!ids.includes(id)) {
        strip.dispose();
        this.strips.delete(id);
      }
    }
    this.master.sync(master, dbToGain(master.volume), state.bpm);
  }

  /** Peak levels (the master's and each channel's by id), and each compressor's gain reduction in dB by effect id. */
  levels() {
    const channels = {};
    const reductions = {};
    for (const [id, strip] of this.strips) channels[id] = strip.peak();
    for (const strip of [...this.strips.values(), this.master]) {
      for (const [id, effect] of strip.effects) if (effect.body.reduction) reductions[id] = effect.body.reduction();
    }
    return { master: this.master.peak(), channels, reductions };
  }
}
