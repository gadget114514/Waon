import './style.css';

// MIDI note numbers (60 = middle C)
const CHORDS = [
  { name: 'C', notes: [60, 64, 67] },
  { name: 'Dm', notes: [62, 65, 69] },
  { name: 'Em', notes: [64, 67, 71] },
  { name: 'F', notes: [65, 69, 72] },
  { name: 'G', notes: [67, 71, 74] },
  { name: 'Am', notes: [69, 72, 76] },
  { name: 'G7', notes: [67, 71, 74, 77] },
  { name: 'Cmaj7', notes: [60, 64, 67, 71] },
];

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const ctx = new AudioCtx();

// Signal chain: voices -> filter -> master -> speakers
const master = ctx.createGain();
master.gain.value = 0.6;
master.connect(ctx.destination);

const filter = ctx.createBiquadFilter();
filter.type = 'lowpass';
filter.frequency.value = 2200;
filter.Q.value = 0.7;
filter.connect(master);

const ATTACK = 0.03; // seconds
const RELEASE = 0.25; // seconds

// chord name -> { group, oscs }
const activeVoices = new Map();

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function startChord(chord) {
  if (activeVoices.has(chord.name)) return;
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  const group = ctx.createGain();
  // Scale each chord so that adding more notes doesn't get too loud.
  const level = 0.5 / Math.sqrt(chord.notes.length);
  group.gain.setValueAtTime(0, now);
  group.gain.linearRampToValueAtTime(level, now + ATTACK);
  group.connect(filter);

  const oscs = chord.notes.map((midi) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    osc.connect(group);
    osc.start(now);
    return osc;
  });

  activeVoices.set(chord.name, { group, oscs });
}

function stopChord(chord) {
  const voice = activeVoices.get(chord.name);
  if (!voice) return;
  activeVoices.delete(chord.name);

  const now = ctx.currentTime;
  const { group, oscs } = voice;
  group.gain.cancelScheduledValues(now);
  group.gain.setValueAtTime(group.gain.value, now);
  group.gain.linearRampToValueAtTime(0, now + RELEASE);
  oscs.forEach((osc) => osc.stop(now + RELEASE + 0.05));
}

function createPad(chord) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pad';
  button.setAttribute('aria-label', `${chord.name} を鳴らす`);
  button.innerHTML = `
    <span class="chord-name">${chord.name}</span>
    <span class="chord-notes">${chord.notes.map(midiName).join(' ')}</span>
  `;

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-active');
    startChord(chord);
  });

  const release = () => {
    button.classList.remove('is-active');
    stopChord(chord);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);

  // Prevent long-press context menus on mobile.
  button.addEventListener('contextmenu', (event) => event.preventDefault());

  return button;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

const pads = document.getElementById('pads');
CHORDS.forEach((chord) => pads.appendChild(createPad(chord)));
