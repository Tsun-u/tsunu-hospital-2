/* audio.js — 背景音樂引擎（Web Audio 合成，沒有音檔）。
   作曲器是純函式：固定種子 → 音符表；排程器把音符表送進 AudioContext。
   編曲心法參考 AMIX「EASY 8BIT EDITOR」公開的規則（曲式 A→A'→B→サビ、動機反覆與變形、
   句尾落根音、三度下和聲、貝斯八度跳、8 beat 鼓組、25% duty 的 pulse 音色），實作為本專案原創。
   對外：Music.compose / attach / play / setEnabled / setSeeds / renderOffline / status */

const Music = (() => {
  const MASTER_VOLUME = 0.05;
  const LOOKAHEAD_SECONDS = 0.3;
  const TICK_MS = 100;
  const DEFAULT_SEEDS = { open: 1, rest: 1 };
  /* 每首曲子的音量係數：四軌合起來的看診曲比單軌的休診曲響很多，壓到峰值比音效低 6 dB 以上。 */
  const SONG_LEVEL = { open: 0.3, rest: 0.75 };

  /* ---------- 亂數與音高 ---------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (random, list) => list[Math.floor(random() * list.length)];
  const midiToFreq = midi => 440 * Math.pow(2, (midi - 69) / 12);
  const pitchClass = midi => ((midi % 12) + 12) % 12;

  const PENTATONIC = [0, 2, 4, 7, 9];
  const CHORDS = { C: [0, 4, 7], G: [7, 11, 2], Am: [9, 0, 4], F: [5, 9, 0], Dm: [2, 5, 9], Em: [4, 7, 11] };
  const chordRoot = chord => CHORDS[chord][0];
  const isChordTone = (midi, chord) => CHORDS[chord].includes(pitchClass(midi));

  /* 和弦感知音階：五聲音階加上和弦音，去掉跟和弦音只差半音的級音，攤成音域內的 MIDI 清單。 */
  function scaleNotes(chord, low, high) {
    const tones = CHORDS[chord];
    const classes = new Set(tones);
    PENTATONIC.forEach(pc => {
      const clashes = tones.some(tone => (tone - pc + 12) % 12 === 1 || (pc - tone + 12) % 12 === 1);
      if (!clashes) classes.add(pc);
    });
    const notes = [];
    for (let midi = low; midi <= high; midi += 1) if (classes.has(pitchClass(midi))) notes.push(midi);
    return notes;
  }
  function nearestIndex(scale, midi) {
    let best = 0;
    scale.forEach((note, index) => { if (Math.abs(note - midi) < Math.abs(scale[best] - midi)) best = index; });
    return best;
  }
  function nearestChordToneIndex(scale, chord, index) {
    let best = -1;
    scale.forEach((note, candidate) => {
      if (!isChordTone(note, chord)) return;
      if (best < 0 || Math.abs(candidate - index) < Math.abs(best - index)) best = candidate;
    });
    return best < 0 ? index : best;
  }
  /* 某個音級裡最靠近 around 的音，限制在音域內。 */
  function nearestPitchOfClass(pc, around, range) {
    let best = null;
    for (let midi = range.low; midi <= range.high; midi += 1) {
      if (pitchClass(midi) === pc && (best === null || Math.abs(midi - around) < Math.abs(best - around))) best = midi;
    }
    return best === null ? around : best;
  }
  /* 和聲：和弦音裡低於主旋律且最近的那個音（大致是三度下）。 */
  function harmonyBelow(midi, chord) {
    for (let candidate = midi - 2; candidate >= midi - 12; candidate -= 1) if (isChordTone(candidate, chord)) return candidate;
    return midi - 12;
  }

  /* ---------- 動機：節奏骨架＋輪廓（級數差） ---------- */

  /* 一小節 8 個八分音符格；第 1、3 拍（格 0、4）必有音，其餘依亂數填到 5～7 個音。 */
  function motifRhythm(random) {
    const slots = [0, 4];
    const extra = [1, 2, 3, 5, 6, 7].filter(() => random() < 0.55);
    while (slots.length + extra.length < 5) {
      const candidate = pick(random, [1, 2, 3, 5, 6, 7]);
      if (!slots.includes(candidate) && !extra.includes(candidate)) extra.push(candidate);
    }
    while (slots.length + extra.length > 7) extra.pop();
    return slots.concat(extra).sort((a, b) => a - b);
  }
  /* 輪廓：級進為主，偶爾跳進（≤3 級），跳進後反向級進。回傳相對錨點的級數差。 */
  function motifContour(random, count) {
    const offsets = [0];
    let lastLeap = 0;
    for (let index = 1; index < count; index += 1) {
      let step;
      if (lastLeap !== 0) { step = lastLeap > 0 ? -1 : 1; lastLeap = 0; }
      else if (random() < 0.25) { step = pick(random, [-3, -2, 2, 3]); lastLeap = step; }
      else step = random() < 0.5 ? 1 : -1;
      offsets.push(offsets[index - 1] + step);
    }
    return offsets;
  }
  function makeMotif(random, bars) {
    return Array.from({ length: bars }, () => {
      const slots = motifRhythm(random);
      return { slots, offsets: motifContour(random, slots.length) };
    });
  }

  /* 超出音域的級數往回折，而不是貼在邊界上變成一排同音。 */
  function reflectIntoRange(degree, max) {
    if (degree < 0) degree = -degree;
    if (degree > max) degree = 2 * max - degree;
    return Math.max(0, Math.min(max, degree));
  }
  /* 把動機的一個小節放到指定和弦上：錨點吸附和弦音，強拍再吸附一次，其餘沿音階級進。 */
  function realizeBar(motifBar, chord, options) {
    const scale = scaleNotes(chord, options.low, options.high);
    const anchor = nearestChordToneIndex(scale, chord, nearestIndex(scale, options.anchorMidi));
    const notes = [];
    motifBar.slots.forEach((slot, index) => {
      let degree = reflectIntoRange(anchor + motifBar.offsets[index], scale.length - 1);
      if (slot % 4 === 0) degree = nearestChordToneIndex(scale, chord, degree);
      const nextSlot = index + 1 < motifBar.slots.length ? motifBar.slots[index + 1] : 8;
      notes.push({ slot, midi: scale[degree], eighths: Math.min(2, nextSlot - slot) });
    });
    return notes;
  }
  /* 樂句收尾：第 3 拍落根音、拉長、後面的音拿掉。 */
  function landOnRoot(notes, chord, range) {
    const kept = notes.filter(note => note.slot < 4);
    const previous = kept.length ? kept[kept.length - 1].midi : 76;
    kept.push({ slot: 4, midi: nearestPitchOfClass(chordRoot(chord), previous, range), eighths: 4 });
    return kept;
  }

  /* ---------- 看診曲：BPM 132，16 小節 A / A' / B / サビ ---------- */

  const OPEN_SECTIONS = [
    { name: 'A', chords: ['C', 'G', 'Am', 'F'], low: 72, high: 86, lift: 0 },
    { name: "A'", chords: ['C', 'G', 'Am', 'F'], low: 72, high: 86, lift: 0 },
    { name: 'B', chords: ['C', 'G', 'Am', 'F'], low: 74, high: 86, lift: 2 },
    { name: 'chorus', chords: ['C', 'F', 'G', 'C'], low: 76, high: 88, lift: 4 },
  ];
  const OPEN_TOP_NOTE = 88;

  function composeOpen(seed) {
    const random = mulberry32(seed * 7919 + 17);
    const motif = makeMotif(random, 2);
    const lead = [];
    const harmony = [];
    let anchorMidi = 79;
    OPEN_SECTIONS.forEach((section, sectionIndex) => {
      section.chords.forEach((chord, barInSection) => {
        const bar = sectionIndex * 4 + barInSection;
        const motifBar = motif[barInSection % 2];
        const lifted = { slots: motifBar.slots, offsets: motifBar.offsets.map(offset => offset + section.lift) };
        const center = (section.low + section.high) / 2;
        let notes = realizeBar(lifted, chord, { low: section.low, high: section.high, anchorMidi: (anchorMidi + center) / 2 });
        if (section.name === 'chorus' && barInSection === 0) notes[0] = { ...notes[0], midi: OPEN_TOP_NOTE };
        if (section.name === "A'" && barInSection === 2) notes = varyTail(notes, chord, section);
        if (barInSection === 3) notes = landOnRoot(notes, chord, section);
        notes.forEach(note => {
          const event = { bar, beat: note.slot / 2, midi: note.midi, beats: note.eighths / 2 };
          lead.push(event);
          if (section.name === 'chorus') harmony.push({ ...event, midi: harmonyBelow(note.midi, chord) });
        });
        anchorMidi = notes[notes.length - 1].midi;
      });
    });
    const bass = [];
    const drums = [];
    OPEN_SECTIONS.forEach((section, sectionIndex) => {
      section.chords.forEach((chord, barInSection) => {
        const bar = sectionIndex * 4 + barInSection;
        const root = 36 + chordRoot(chord);
        for (let beat = 0; beat < 4; beat += 1) {
          bass.push({ bar, beat, midi: root, beats: 0.5 });
          bass.push({ bar, beat: beat + 0.5, midi: root + 12, beats: 0.5 });
          drums.push({ bar, beat, kind: beat % 2 === 0 ? 'kick' : 'snare' });
          drums.push({ bar, beat, kind: 'hat' });
          drums.push({ bar, beat: beat + 0.5, kind: 'hat' });
        }
      });
    });
    const rollBar = 11;
    for (let index = drums.length - 1; index >= 0; index -= 1) {
      if (drums[index].bar === rollBar && drums[index].beat === 3 && drums[index].kind === 'snare') drums.splice(index, 1);
    }
    [0, 0.25, 0.5, 0.75].forEach(offset => drums.push({ bar: rollBar, beat: 3 + offset, kind: 'snare' }));
    return { kind: 'open', bpm: 132, bars: 16, breathBeats: 0, chords: OPEN_SECTIONS.flatMap(section => section.chords), lead, harmony, bass, drums, pad: [] };
  }
  /* A' 段的變形：最後兩個音一個往下一級、一個往上一級，強拍仍吸附和弦音。 */
  function varyTail(notes, chord, section) {
    const scale = scaleNotes(chord, section.low, section.high);
    return notes.map((note, index) => {
      if (index < notes.length - 2) return note;
      let degree = nearestIndex(scale, note.midi) + (index === notes.length - 2 ? -1 : 1);
      degree = Math.max(0, Math.min(scale.length - 1, degree));
      if (note.slot % 4 === 0) degree = nearestChordToneIndex(scale, chord, degree);
      return { ...note, midi: scale[degree] };
    });
  }

  /* ---------- 休診曲：BPM 72，8 小節 Am–F–C–G 兩輪，音樂盒音色 ---------- */

  const REST_CHORDS = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'];

  function composeRest(seed) {
    const random = mulberry32(seed * 104729 + 5);
    const low = 72;
    const high = 86;
    const lead = [];
    const harmony = [];
    const pad = [];
    let previous = 76;
    REST_CHORDS.forEach((chord, bar) => {
      const scale = scaleNotes(chord, low, high);
      const onsets = [0].concat(pick(random, [[2], [1.5, 3], [2, 3], [1, 2.5]]));
      let degree = nearestChordToneIndex(scale, chord, nearestIndex(scale, previous));
      const notes = [];
      onsets.forEach((beat, index) => {
        if (index > 0) {
          const step = random() < 0.2 ? pick(random, [-2, 2]) : (random() < 0.5 ? 1 : -1);
          degree = Math.max(0, Math.min(scale.length - 1, degree + step));
        }
        const nextBeat = index + 1 < onsets.length ? onsets[index + 1] : 4;
        notes.push({ beat, midi: scale[degree], beats: nextBeat - beat });
      });
      if (bar % 4 === 3) {
        const last = notes[notes.length - 1];
        last.midi = nearestPitchOfClass(chordRoot(chord), last.midi, { low, high });
        harmony.push({ bar, beat: last.beat, midi: harmonyBelow(last.midi, chord), beats: last.beats });
      }
      notes.forEach(note => lead.push({ bar, ...note }));
      previous = notes[notes.length - 1].midi;
      pad.push({ bar, beat: 0, midis: CHORDS[chord].map((pc, index) => 48 + pc + (index > 0 && pc < CHORDS[chord][0] ? 12 : 0)), beats: 4 });
    });
    return { kind: 'rest', bpm: 72, bars: 8, breathBeats: 4, chords: REST_CHORDS, lead, harmony, bass: [], drums: [], pad };
  }

  function compose(kind, seed) {
    return kind === 'rest' ? composeRest(seed) : composeOpen(seed);
  }

  /* ---------- 音符表 → 時間軸事件 ---------- */

  function songEvents(song) {
    const secondsPerBeat = 60 / song.bpm;
    const at = (bar, beat) => (bar * 4 + beat) * secondsPerBeat;
    const events = [];
    const leadVoice = song.kind === 'open' ? 'pulse' : 'pluck';
    const harmonyVoice = song.kind === 'open' ? 'triangle' : 'pluckSoft';
    song.lead.forEach(note => events.push({ t: at(note.bar, note.beat), voice: leadVoice, midi: note.midi, len: note.beats * secondsPerBeat }));
    song.harmony.forEach(note => events.push({ t: at(note.bar, note.beat), voice: harmonyVoice, midi: note.midi, len: note.beats * secondsPerBeat }));
    song.bass.forEach(note => events.push({ t: at(note.bar, note.beat), voice: 'bass', midi: note.midi, len: note.beats * secondsPerBeat }));
    song.drums.forEach(hit => events.push({ t: at(hit.bar, hit.beat), voice: hit.kind }));
    song.pad.forEach(chord => events.push({ t: at(chord.bar, chord.beat), voice: 'pad', midis: chord.midis, len: chord.beats * secondsPerBeat }));
    events.sort((a, b) => a.t - b.t);
    return { events, loopSeconds: (song.bars * 4 + song.breathBeats) * secondsPerBeat };
  }

  /* ---------- 音色 ---------- */

  function makeVoices(ctx) {
    const harmonics = 32;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    for (let n = 1; n < harmonics; n += 1) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);   // 25% duty pulse
    const pulseWave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;

    function envelope(bus, when, peak, attack, hold, release) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(peak, when + attack);
      gain.gain.setValueAtTime(peak, when + attack + hold);
      gain.gain.linearRampToValueAtTime(0.0001, when + attack + hold + release);
      gain.connect(bus);
      return gain;
    }
    function oscillator(bus, freq, type, when, peak, attack, hold, release) {
      const osc = ctx.createOscillator();
      if (type === 'pulse') osc.setPeriodicWave(pulseWave); else osc.type = type;
      osc.frequency.value = freq;
      osc.connect(envelope(bus, when, peak, attack, hold, release));
      osc.start(when);
      osc.stop(when + attack + hold + release + 0.05);
    }
    function noise(bus, when, filterType, frequency, peak, release) {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = frequency;
      source.connect(filter).connect(envelope(bus, when, peak, 0.002, 0, release));
      source.start(when);
      source.stop(when + release + 0.05);
    }
    /* 音樂盒鈴音：sine 加三倍頻泛音，長衰減（沿用生態瓶的寫法）。 */
    function pluck(bus, freq, when, volume, decay) {
      [[1, volume, decay], [3, volume * 0.16, Math.min(1.1, decay)]].forEach(([multiple, peak, tail]) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq * multiple;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(peak, when);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + tail);
        osc.connect(gain).connect(bus);
        osc.start(when);
        osc.stop(when + tail + 0.1);
      });
    }

    return {
      pulse: (bus, ev, when) => oscillator(bus, midiToFreq(ev.midi), 'pulse', when, 0.32, 0.005, Math.max(0.02, ev.len - 0.06), 0.04),
      triangle: (bus, ev, when) => oscillator(bus, midiToFreq(ev.midi), 'triangle', when, 0.24, 0.01, Math.max(0.02, ev.len - 0.06), 0.04),
      bass: (bus, ev, when) => oscillator(bus, midiToFreq(ev.midi), 'triangle', when, 0.5, 0.005, Math.max(0.02, ev.len - 0.08), 0.05),
      kick: (bus, ev, when) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, when);
        osc.frequency.exponentialRampToValueAtTime(48, when + 0.1);
        osc.connect(envelope(bus, when, 0.7, 0.002, 0.02, 0.13));
        osc.start(when);
        osc.stop(when + 0.2);
      },
      snare: (bus, ev, when) => {
        noise(bus, when, 'bandpass', 1800, 0.28, 0.12);
        oscillator(bus, 180, 'sine', when, 0.2, 0.002, 0.01, 0.06);
      },
      hat: (bus, ev, when) => noise(bus, when, 'highpass', 7000, 0.09, 0.035),
      pluck: (bus, ev, when) => pluck(bus, midiToFreq(ev.midi), when, 0.42, 2.6),
      pluckSoft: (bus, ev, when) => pluck(bus, midiToFreq(ev.midi), when, 0.2, 2.2),
      pad: (bus, ev, when) => ev.midis.forEach(midi => oscillator(bus, midiToFreq(midi), 'triangle', when, 0.055, 0.7, Math.max(0.1, ev.len - 0.7), 1.4)),
    };
  }

  /* ---------- 即時排程 ---------- */

  let ctx = null;
  let voices = null;
  let musicOut = null;
  let enabled = true;
  let seeds = { ...DEFAULT_SEEDS };
  let current = null;       // { kind, bus, events, loopSeconds, loopStart, index }
  let timer = 0;

  function attach(audioContext) {
    if (ctx === audioContext) return;
    ctx = audioContext;
    voices = makeVoices(ctx);
    musicOut = ctx.createGain();
    musicOut.gain.value = enabled ? MASTER_VOLUME : 0;
    musicOut.connect(ctx.destination);
    if (current) startSong(current.kind);
  }

  function startSong(kind) {
    const { events, loopSeconds } = songEvents(compose(kind, seeds[kind]));
    const bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.connect(musicOut);
    bus.gain.linearRampToValueAtTime(SONG_LEVEL[kind], ctx.currentTime + 0.6);
    current = { kind, bus, events, loopSeconds, loopStart: ctx.currentTime + 0.05, index: 0 };
    if (!timer) timer = setInterval(tick, TICK_MS);
  }
  function fadeOut(song) {
    const now = ctx.currentTime;
    song.bus.gain.cancelScheduledValues(now);
    song.bus.gain.setValueAtTime(song.bus.gain.value, now);
    song.bus.gain.linearRampToValueAtTime(0.0001, now + 0.6);
    setTimeout(() => song.bus.disconnect(), 800);
  }
  function tick() {
    if (!current || !enabled || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + LOOKAHEAD_SECONDS;
    if (current.loopStart < ctx.currentTime - 1) {            // 分頁被凍結太久：從現在重新起算
      current.loopStart = ctx.currentTime + 0.05;
      current.index = 0;
    }
    while (current.loopStart + current.events[current.index].t < horizon) {
      const event = current.events[current.index];
      voices[event.voice](current.bus, event, current.loopStart + event.t);
      current.index += 1;
      if (current.index >= current.events.length) {
        current.index = 0;
        current.loopStart += current.loopSeconds;
      }
    }
  }

  function play(kind) {
    if (current && current.kind === kind) return;
    if (!ctx) { current = { kind }; return; }
    if (current && current.bus) fadeOut(current);
    startSong(kind);
  }
  function setEnabled(on) {
    const resumed = on && !enabled;
    enabled = on;
    if (!musicOut) return;
    musicOut.gain.cancelScheduledValues(ctx.currentTime);
    musicOut.gain.linearRampToValueAtTime(on ? MASTER_VOLUME : 0, ctx.currentTime + 0.4);
    if (resumed && current && current.bus) { current.loopStart = ctx.currentTime + 0.05; current.index = 0; }   // 關掉再開：從頭播
  }
  function setSeeds(next) {
    seeds = { ...seeds, ...next };
    if (current && current.bus) { const kind = current.kind; fadeOut(current); current = null; startSong(kind); }
  }

  /* 離線渲染整段（音量檢查用）：回傳 AudioBuffer。 */
  function renderOffline(kind, seconds, seed) {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(1, Math.ceil(seconds * 44100), 44100);
    const offlineVoices = makeVoices(offline);
    const out = offline.createGain();
    out.gain.value = MASTER_VOLUME * SONG_LEVEL[kind];
    out.connect(offline.destination);
    const { events, loopSeconds } = songEvents(compose(kind, seed === undefined ? seeds[kind] : seed));
    for (let loopStart = 0; loopStart < seconds; loopStart += loopSeconds) {
      events.forEach(event => { if (loopStart + event.t < seconds) offlineVoices[event.voice](out, event, loopStart + event.t); });
    }
    return offline.startRendering();
  }

  const status = () => current ? { kind: current.kind, scheduling: Boolean(current.bus), index: current.index, seeds: { ...seeds } } : null;

  return { compose, attach, play, setEnabled, setSeeds, renderOffline, status, DEFAULT_SEEDS, MASTER_VOLUME };
})();

if (typeof module !== 'undefined') module.exports = Music;
