import './style.css';

// MIDI note numbers (60 = middle C)
const PAD_COUNT = 8;
const MAX_NOTES = 4;
const PIANO_LOW = 60; // C4
const PIANO_HIGH = 72; // C5
const PADS_KEY = 'waon.pads';
const TAKES_KEY = 'waon.takes';

const DEFAULT_PADS = [
  { name: 'C', notes: [60, 64, 67] },
  { name: 'Dm', notes: [62, 65, 69] },
  { name: 'Em', notes: [64, 67, 71] },
  { name: 'F', notes: [65, 69, 72] },
  { name: 'G', notes: [67, 71, 74] },
  { name: 'Am', notes: [69, 72, 76] },
  { name: 'G7', notes: [67, 71, 74, 77] },
  { name: 'Cmaj7', notes: [60, 64, 67, 71] },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
function isBlack(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

// ---------- Audio ----------

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

// voice key -> { group, oscs }
const activeVoices = new Map();

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function startVoice(key, notes) {
  if (!notes.length || activeVoices.has(key)) return;
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  const group = ctx.createGain();
  // Scale so that adding more notes doesn't get too loud.
  const level = 0.5 / Math.sqrt(notes.length);
  group.gain.setValueAtTime(0, now);
  group.gain.linearRampToValueAtTime(level, now + ATTACK);
  group.connect(filter);

  const oscs = notes.map((midi) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    osc.connect(group);
    osc.start(now);
    return osc;
  });

  activeVoices.set(key, { group, oscs });
}

function stopVoice(key) {
  const voice = activeVoices.get(key);
  if (!voice) return;
  activeVoices.delete(key);

  const now = ctx.currentTime;
  const { group, oscs } = voice;
  group.gain.cancelScheduledValues(now);
  group.gain.setValueAtTime(group.gain.value, now);
  group.gain.linearRampToValueAtTime(0, now + RELEASE);
  oscs.forEach((osc) => osc.stop(now + RELEASE + 0.05));
}

// ---------- Storage ----------

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

function sanitizeNotes(list) {
  if (!Array.isArray(list)) return [];
  const notes = [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0 && n <= 127))];
  return notes.sort((a, b) => a - b).slice(0, MAX_NOTES);
}

function clonePads(list) {
  return list.map((p) => ({ name: p.name, notes: [...p.notes] }));
}

function loadPads() {
  const saved = loadJson(PADS_KEY, null);
  if (!Array.isArray(saved) || saved.length !== PAD_COUNT) return clonePads(DEFAULT_PADS);
  return saved.map((p, i) => ({
    name: typeof p?.name === 'string' ? p.name.slice(0, 10) : DEFAULT_PADS[i].name,
    notes: sanitizeNotes(p?.notes),
  }));
}

function loadTakes() {
  const saved = loadJson(TAKES_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter((t) => t && Array.isArray(t.events));
}

function savePads() {
  saveJson(PADS_KEY, pads);
}

function saveTakes() {
  saveJson(TAKES_KEY, takes);
}

// ---------- State ----------

let pads = loadPads();
let takes = loadTakes(); // saved recordings
let currentTake = null; // selected take (saved or unsaved)
let recording = null; // { start, events } while recording
let playback = null; // { timers, keys } while playing
let editMode = false;
let selectedPad = 0;
let hintTimer = null;

const $ = (id) => document.getElementById(id);
const els = {
  hint: $('hint'),
  editToggle: $('edit-toggle'),
  rec: $('rec'),
  play: $('play'),
  takes: $('takes'),
  save: $('save'),
  download: $('download'),
  delete: $('delete'),
  pads: $('pads'),
  editor: $('editor'),
  padName: $('pad-name'),
  padNotes: $('pad-notes'),
  piano: $('piano'),
};

// ---------- Note input (user) and recording ----------

function nowInRecording() {
  return performance.now() - recording.start;
}

function userNoteOn(id, notes) {
  startVoice(id, notes);
  if (recording) recording.events.push({ t: nowInRecording(), on: true, id, notes: [...notes] });
}

function userNoteOff(id) {
  stopVoice(id);
  if (recording) recording.events.push({ t: nowInRecording(), on: false, id });
}

function bindHold(el, id, getNotes, onPress) {
  el.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (onPress && onPress(event) === false) return;
    el.setPointerCapture(event.pointerId);
    el.classList.add('is-active');
    userNoteOn(id, getNotes());
  });
  const release = () => {
    if (!el.classList.contains('is-active')) return;
    el.classList.remove('is-active');
    userNoteOff(id);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
  el.addEventListener('contextmenu', (event) => event.preventDefault());
}

// ---------- Pads ----------

function createPad(index) {
  const pad = pads[index];
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pad' + (editMode && index === selectedPad ? ' is-selected' : '');
  el.setAttribute('aria-label', `${pad.name} を鳴らす`);

  const name = document.createElement('span');
  name.className = 'chord-name';
  name.textContent = pad.name || '—';
  const notes = document.createElement('span');
  notes.className = 'chord-notes';
  notes.textContent = pad.notes.length ? pad.notes.map(midiName).join(' ') : '（音なし）';
  el.append(name, notes);

  bindHold(
    el,
    `pad${index}`,
    () => pads[index].notes,
    () => {
      if (editMode) {
        selectPad(index);
        return false;
      }
    },
  );
  return el;
}

function renderPads() {
  els.pads.replaceChildren(...pads.map((_, i) => createPad(i)));
}

function selectPad(index) {
  selectedPad = index;
  renderPads();
  renderEditor();
  updateKeyMarks();
}

// ---------- Editor ----------

function renderEditor() {
  els.editor.hidden = !editMode;
  if (!editMode) return;
  const pad = pads[selectedPad];
  if (document.activeElement !== els.padName) els.padName.value = pad.name;
  els.padNotes.replaceChildren(
    ...pad.notes.map((midi) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = midiName(midi);
      return chip;
    }),
  );
  if (!pad.notes.length) {
    const empty = document.createElement('span');
    empty.textContent = '鍵盤を押して音を追加（最大4音）';
    els.padNotes.append(empty);
  }
}

function toggleNote(midi) {
  const pad = pads[selectedPad];
  const index = pad.notes.indexOf(midi);
  if (index >= 0) {
    pad.notes.splice(index, 1);
  } else if (pad.notes.length >= MAX_NOTES) {
    flashHint(`音は最大${MAX_NOTES}つまでです`);
    return;
  } else {
    pad.notes.push(midi);
    pad.notes.sort((a, b) => a - b);
  }
  savePads();
  renderPads();
  renderEditor();
  updateKeyMarks();
}

function flashHint(message) {
  els.hint.textContent = message;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateHint, 1500);
}

function updateHint() {
  els.hint.textContent = editMode
    ? 'ボタンを選び、名前と鍵盤で音を編集します'
    : 'ボタンを押している間、和音が鳴ります';
}

// ---------- Piano ----------

function buildPiano() {
  const whites = [];
  for (let midi = PIANO_LOW; midi <= PIANO_HIGH; midi++) {
    if (!isBlack(midi)) whites.push(midi);
  }
  const share = 100 / whites.length;

  whites.forEach((midi) => {
    const key = document.createElement('div');
    key.className = 'key white';
    key.dataset.midi = midi;
    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = midiName(midi);
    key.append(label);
    bindKey(key, midi);
    els.piano.append(key);
  });

  for (let midi = PIANO_LOW; midi < PIANO_HIGH; midi++) {
    if (!isBlack(midi)) continue;
    const whiteIndex = whites.indexOf(midi - 1);
    const key = document.createElement('div');
    key.className = 'key black';
    key.dataset.midi = midi;
    // Centre the black key on the boundary to the right of the white key before it.
    key.style.left = `calc(${(whiteIndex + 1) * share}% - ${share * 0.3}%)`;
    key.style.width = `${share * 0.6}%`;
    bindKey(key, midi);
    els.piano.append(key);
  }
}

function bindKey(el, midi) {
  bindHold(el, `key${midi}`, () => [midi], () => {
    if (editMode) toggleNote(midi);
  });
}

function updateKeyMarks() {
  const inPad = new Set(editMode ? pads[selectedPad].notes : []);
  els.piano.querySelectorAll('.key').forEach((key) => {
    key.classList.toggle('in-pad', inPad.has(Number(key.dataset.midi)));
  });
}

// ---------- Recording, takes and playback ----------

function toggleRecord() {
  if (recording) {
    currentTake = { name: '', duration: performance.now() - recording.start, events: recording.events };
    recording = null;
  } else {
    stopPlayback();
    recording = { start: performance.now(), events: [] };
  }
  updateControls();
}

function playTake(take) {
  stopPlayback();
  const timers = [];
  const keys = new Set();
  take.events.forEach((event) => {
    const key = `pb:${event.id}`;
    timers.push(
      setTimeout(() => {
        if (event.on) {
          keys.add(key);
          startVoice(key, event.notes);
        } else {
          stopVoice(key);
        }
      }, event.t),
    );
  });
  timers.push(setTimeout(stopPlayback, take.duration + 300));
  playback = { timers, keys };
  updateControls();
}

function stopPlayback() {
  if (!playback) return;
  playback.timers.forEach(clearTimeout);
  playback.keys.forEach(stopVoice);
  playback = null;
  updateControls();
}

function togglePlay() {
  if (playback) {
    stopPlayback();
  } else if (currentTake && !recording) {
    playTake(currentTake);
  }
}

function saveCurrentTake() {
  if (!currentTake || takes.includes(currentTake)) return;
  const stamp = new Date().toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  currentTake.name = `録音 ${stamp}`;
  takes.push(currentTake);
  saveTakes();
  updateControls();
}

function deleteCurrentTake() {
  if (!currentTake) return;
  stopPlayback();
  takes = takes.filter((t) => t !== currentTake);
  currentTake = null;
  saveTakes();
  updateControls();
}

function downloadCurrentTake() {
  if (!currentTake) return;
  const data = {
    format: 'waon-take',
    version: 1,
    name: currentTake.name || '未保存の録音',
    duration: Math.round(currentTake.duration),
    events: currentTake.events,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = data.name.replace(/[\\/:*?"<>|\s]+/g, '_');
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeName || 'waon-take'}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderTakes() {
  const options = takes.map((take, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = take.name;
    return option;
  });
  if (currentTake && !takes.includes(currentTake)) {
    const option = document.createElement('option');
    option.value = 'unsaved';
    option.textContent = '未保存の録音';
    options.push(option);
  }
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '録音なし';
    options.push(option);
  }
  els.takes.replaceChildren(...options);
  els.takes.disabled = !takes.length && !currentTake;

  if (!currentTake) {
    els.takes.value = '';
  } else if (takes.includes(currentTake)) {
    els.takes.value = String(takes.indexOf(currentTake));
  } else {
    els.takes.value = 'unsaved';
  }
}

function updateControls() {
  els.rec.textContent = recording ? '■ 停止' : '● 録音';
  els.rec.classList.toggle('is-on', !!recording);

  els.play.textContent = playback ? '■ 停止' : '▶ 再生';
  els.play.classList.toggle('is-on', !!playback);
  els.play.disabled = !playback && (!currentTake || !currentTake.events.length || !!recording);

  const unsaved = !!currentTake && !takes.includes(currentTake);
  els.save.disabled = !unsaved;
  els.download.disabled = !currentTake;
  els.delete.disabled = !currentTake;

  els.editToggle.textContent = editMode ? '完了' : '編集';
  els.editToggle.classList.toggle('is-on', editMode);

  renderTakes();
}

// ---------- Edit mode ----------

function toggleEditMode() {
  editMode = !editMode;
  renderPads();
  renderEditor();
  updateKeyMarks();
  updateHint();
  updateControls();
}

// ---------- Wiring ----------

els.editToggle.addEventListener('click', toggleEditMode);
els.rec.addEventListener('click', toggleRecord);
els.play.addEventListener('click', togglePlay);
els.save.addEventListener('click', saveCurrentTake);
els.download.addEventListener('click', downloadCurrentTake);
els.delete.addEventListener('click', deleteCurrentTake);

els.takes.addEventListener('change', () => {
  stopPlayback();
  if (els.takes.value === 'unsaved' || els.takes.value === '') return;
  currentTake = takes[Number(els.takes.value)] ?? null;
  updateControls();
});

els.padName.addEventListener('input', () => {
  pads[selectedPad].name = els.padName.value.slice(0, 10);
  savePads();
  renderPads();
});

els.pads.addEventListener('contextmenu', (event) => event.preventDefault());
els.piano.addEventListener('contextmenu', (event) => event.preventDefault());

// ---------- Init ----------

renderPads();
buildPiano();
renderEditor();
updateKeyMarks();
updateHint();
updateControls();
