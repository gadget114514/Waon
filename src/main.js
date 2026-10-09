import './style.css';

const PAD_COUNT = 9;
const MAX_NOTES = 4;
const PIANO_LOW = 60; // C4
const PIANO_HIGH = 72; // C5
const CHORD_BASE = 60; // root notes are placed in the octave starting at C4
const MIN_BLOCK_MS = 50;
const NUDGE_MS = 100;
const PADS_KEY = 'waon.pads';
const TAKES_KEY = 'waon.takes';

const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// label: shown on the picker button; suffix: appended to the root in the pad name
const QUALITIES = [
  { id: 'M', label: 'M', suffix: '', intervals: [0, 4, 7] },
  { id: 'm', label: 'm', suffix: 'm', intervals: [0, 3, 7] },
  { id: '7', label: '7', suffix: '7', intervals: [0, 4, 7, 10] },
  { id: 'maj7', label: 'M7', suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { id: 'm7', label: 'm7', suffix: 'm7', intervals: [0, 3, 7, 10] },
  { id: '6', label: '6', suffix: '6', intervals: [0, 4, 7, 9] },
  { id: 'sus4', label: 'sus4', suffix: 'sus4', intervals: [0, 5, 7] },
  { id: 'sus2', label: 'sus2', suffix: 'sus2', intervals: [0, 2, 7] },
  { id: 'dim', label: 'dim', suffix: 'dim', intervals: [0, 3, 6] },
  { id: 'aug', label: 'aug', suffix: 'aug', intervals: [0, 4, 8] },
];
const QUALITY_BY_ID = Object.fromEntries(QUALITIES.map((q) => [q.id, q]));

// Pads keep their chord (root + quality) so the picker can change them.
// root/quality are null for custom pads whose notes were set on the piano.
const DEFAULT_PADS = [
  { name: 'C', root: 0, quality: 'M' },
  { name: 'Dm', root: 2, quality: 'm' },
  { name: 'Em', root: 4, quality: 'm' },
  { name: 'F', root: 5, quality: 'M' },
  { name: 'G', root: 7, quality: 'M' },
  { name: 'Am', root: 9, quality: 'm' },
  { name: 'G7', root: 7, quality: '7' },
  { name: 'Cmaj7', root: 0, quality: 'maj7' },
  { name: 'Dm7', root: 2, quality: 'm7' },
].map((p) => ({ ...p, notes: chordNotes(p.root, p.quality) }));

function chordNotes(root, quality) {
  return QUALITY_BY_ID[quality].intervals.map((i) => CHORD_BASE + root + i);
}

const NOTE_NAMES = ROOT_NAMES;
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

function sanitizeRoot(value) {
  return Number.isInteger(value) && value >= 0 && value <= 11 ? value : null;
}

function sanitizeQuality(value) {
  return typeof value === 'string' && QUALITY_BY_ID[value] ? value : null;
}

function clonePad(pad) {
  return { name: pad.name, root: pad.root, quality: pad.quality, notes: [...pad.notes] };
}

function loadPads() {
  const saved = loadJson(PADS_KEY, null);
  if (!Array.isArray(saved)) return DEFAULT_PADS.map(clonePad);
  // Keep saved pads; fill any missing slots (e.g. after going from 8 to 9 pads) with defaults.
  return Array.from({ length: PAD_COUNT }, (_, i) => {
    const p = saved[i];
    if (!p) return clonePad(DEFAULT_PADS[i]);
    return {
      name: typeof p.name === 'string' ? p.name.slice(0, 10) : DEFAULT_PADS[i].name,
      root: sanitizeRoot(p.root),
      quality: sanitizeQuality(p.quality),
      notes: sanitizeNotes(p.notes),
    };
  });
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
let editMode = false; // editing pads
let takeEditMode = false; // editing the notes of the current take
let selectedPad = 0;
let selectedBlock = 0;
let hintTimer = null;

const $ = (id) => document.getElementById(id);
const els = {
  hint: $('hint'),
  editToggle: $('edit-toggle'),
  rec: $('rec'),
  play: $('play'),
  takeEdit: $('take-edit'),
  takes: $('takes'),
  save: $('save'),
  download: $('download'),
  delete: $('delete'),
  pads: $('pads'),
  editor: $('editor'),
  padName: $('pad-name'),
  roots: $('roots'),
  qualities: $('qualities'),
  padNotes: $('pad-notes'),
  takeEditor: $('take-editor'),
  blocks: $('blocks'),
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

// ---------- Pad editor ----------

function applyChord(root, quality) {
  const pad = pads[selectedPad];
  pad.root = root;
  pad.quality = quality;
  pad.notes = chordNotes(root, quality);
  pad.name = ROOT_NAMES[root] + QUALITY_BY_ID[quality].suffix;
  savePads();
  renderPads();
  renderEditor();
  updateKeyMarks();
}

function setRoot(root) {
  applyChord(root, pads[selectedPad].quality ?? 'M');
}

function setQuality(quality) {
  applyChord(pads[selectedPad].root ?? 0, quality);
}

function buildChordPicker() {
  ROOT_NAMES.forEach((name, root) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.dataset.root = String(root);
    button.addEventListener('click', () => setRoot(root));
    els.roots.append(button);
  });
  QUALITIES.forEach((quality) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = quality.label;
    button.dataset.quality = quality.id;
    button.addEventListener('click', () => setQuality(quality.id));
    els.qualities.append(button);
  });
}

function renderEditor() {
  els.editor.hidden = !editMode;
  if (!editMode) return;
  const pad = pads[selectedPad];
  if (document.activeElement !== els.padName) els.padName.value = pad.name;

  els.roots.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('is-on', Number(button.dataset.root) === pad.root);
  });
  els.qualities.querySelectorAll('button').forEach((button) => {
    button.classList.toggle('is-on', button.dataset.quality === pad.quality);
  });

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

// Piano edits make the pad a custom chord: it no longer follows root/quality.
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
  pad.root = null;
  pad.quality = null;
  savePads();
  renderPads();
  renderEditor();
  updateKeyMarks();
}

// ---------- Take editor (notes of a recording) ----------

// A take's events are on/off pairs; a "block" is one note-on..note-off span.
function takeBlocks(take) {
  const blocks = [];
  const open = new Map();
  take.events.forEach((event) => {
    if (event.on) {
      const block = { notes: [...event.notes], start: event.t, end: null };
      open.set(event.id, block);
      blocks.push(block);
    } else {
      const block = open.get(event.id);
      if (block) {
        block.end = event.t;
        open.delete(event.id);
      }
    }
  });
  blocks.forEach((block) => {
    if (block.end === null) block.end = take.duration;
  });
  return blocks.sort((a, b) => a.start - b.start);
}

// Rebuild the take's events from blocks. Notes-on sort before notes-off at the same time.
function setTakeBlocks(take, blocks) {
  const events = [];
  blocks.forEach((block, i) => {
    const id = `b${i}`;
    events.push({ t: block.start, on: true, id, notes: [...block.notes] });
    events.push({ t: block.end, on: false, id });
  });
  events.sort((a, b) => a.t - b.t || Number(b.on) - Number(a.on));
  take.events = events;
  take.duration = Math.max(0, ...blocks.map((block) => block.end));
}

function currentBlocks() {
  return currentTake ? takeBlocks(currentTake) : [];
}

function commitBlocks(blocks) {
  setTakeBlocks(currentTake, blocks);
  if (takes.includes(currentTake)) saveTakes();
  stopPlayback();
  updateControls();
}

function withSelectedBlock(change) {
  const blocks = currentBlocks();
  const block = blocks[selectedBlock];
  if (!block) return;
  change(block, blocks);
  commitBlocks(blocks);
}

function shiftBlock(deltaMs) {
  withSelectedBlock((block) => {
    const length = block.end - block.start;
    block.start = Math.max(0, block.start + deltaMs);
    block.end = block.start + length;
  });
}

function resizeBlock(deltaMs) {
  withSelectedBlock((block) => {
    block.end = Math.max(block.start + MIN_BLOCK_MS, block.end + deltaMs);
  });
}

function deleteBlock() {
  withSelectedBlock((_block, blocks) => {
    blocks.splice(selectedBlock, 1);
    selectedBlock = Math.max(0, Math.min(selectedBlock, blocks.length - 1));
  });
}

function transposeTake(semitones) {
  if (!currentBlocks().length) return;
  const blocks = currentBlocks();
  blocks.forEach((block) => {
    block.notes = block.notes.map((n) => Math.min(127, Math.max(0, n + semitones)));
  });
  commitBlocks(blocks);
}

function toggleBlockNote(midi) {
  const blocks = currentBlocks();
  const block = blocks[selectedBlock];
  if (!block) {
    flashHint('先に音を選んでください');
    return;
  }
  const index = block.notes.indexOf(midi);
  if (index >= 0) block.notes.splice(index, 1);
  else block.notes.push(midi);
  block.notes.sort((a, b) => a - b);
  commitBlocks(blocks);
}

function renderTakeEditor() {
  els.takeEditor.hidden = !takeEditMode || !currentTake;
  if (els.takeEditor.hidden) return;

  const blocks = currentBlocks();
  selectedBlock = Math.min(selectedBlock, Math.max(0, blocks.length - 1));

  if (!blocks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '音がありません';
    els.blocks.replaceChildren(empty);
  } else {
    els.blocks.replaceChildren(
      ...blocks.map((block, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'block-row' + (i === selectedBlock ? ' is-on' : '');
        const time = (block.start / 1000).toFixed(2);
        const length = ((block.end - block.start) / 1000).toFixed(2);
        const names = block.notes.length ? block.notes.map(midiName).join(' ') : '（音なし）';
        row.textContent = `${time}s  長さ ${length}s  ${names}`;
        row.addEventListener('click', () => {
          selectedBlock = i;
          renderTakeEditor();
          updateKeyMarks();
        });
        return row;
      }),
    );
  }

  const hasBlocks = blocks.length > 0;
  els.takeEditor.querySelectorAll('[data-shift], [data-length], [data-action]').forEach((button) => {
    button.disabled = !hasBlocks;
  });
}

function flashHint(message) {
  els.hint.textContent = message;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateHint, 1500);
}

function updateHint() {
  if (takeEditMode) {
    els.hint.textContent = '音を選び、時間・長さ・鍵盤で編集します';
  } else if (editMode) {
    els.hint.textContent = 'ボタンを選び、コードや鍵盤で音を編集します';
  } else {
    els.hint.textContent = 'ボタンを押している間、和音が鳴ります';
  }
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
    if (takeEditMode) toggleBlockNote(midi);
    else if (editMode) toggleNote(midi);
  });
}

function updateKeyMarks() {
  let marked = [];
  if (takeEditMode && currentTake) {
    marked = currentBlocks()[selectedBlock]?.notes ?? [];
  } else if (editMode) {
    marked = pads[selectedPad].notes;
  }
  const inPad = new Set(marked);
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

  els.takeEdit.textContent = takeEditMode ? '完了' : '並び編集';
  els.takeEdit.classList.toggle('is-on', takeEditMode);
  els.takeEdit.disabled = !takeEditMode && (!currentTake || !!recording);

  els.editToggle.textContent = editMode ? '完了' : '編集';
  els.editToggle.classList.toggle('is-on', editMode);

  renderTakes();
  renderTakeEditor();
  updateKeyMarks();
}

// ---------- Modes ----------

function toggleEditMode() {
  editMode = !editMode;
  if (editMode) takeEditMode = false;
  renderPads();
  renderEditor();
  updateKeyMarks();
  updateHint();
  updateControls();
}

function toggleTakeEditMode() {
  takeEditMode = !takeEditMode;
  if (takeEditMode) {
    editMode = false;
    renderPads();
    renderEditor();
    stopPlayback();
  }
  updateHint();
  updateControls();
}

// ---------- Wiring ----------

els.editToggle.addEventListener('click', toggleEditMode);
els.takeEdit.addEventListener('click', toggleTakeEditMode);
els.rec.addEventListener('click', toggleRecord);
els.play.addEventListener('click', togglePlay);
els.save.addEventListener('click', saveCurrentTake);
els.download.addEventListener('click', downloadCurrentTake);
els.delete.addEventListener('click', deleteCurrentTake);

els.takes.addEventListener('change', () => {
  stopPlayback();
  if (els.takes.value === 'unsaved' || els.takes.value === '') return;
  currentTake = takes[Number(els.takes.value)] ?? null;
  selectedBlock = 0;
  updateControls();
});

els.padName.addEventListener('input', () => {
  pads[selectedPad].name = els.padName.value.slice(0, 10);
  savePads();
  renderPads();
});

els.takeEditor.querySelectorAll('[data-transpose]').forEach((button) => {
  button.addEventListener('click', () => transposeTake(Number(button.dataset.transpose)));
});
els.takeEditor.querySelectorAll('[data-shift]').forEach((button) => {
  button.addEventListener('click', () => shiftBlock(Number(button.dataset.shift)));
});
els.takeEditor.querySelectorAll('[data-length]').forEach((button) => {
  button.addEventListener('click', () => resizeBlock(Number(button.dataset.length)));
});
els.takeEditor.querySelector('[data-action="delete"]').addEventListener('click', deleteBlock);

els.pads.addEventListener('contextmenu', (event) => event.preventDefault());
els.piano.addEventListener('contextmenu', (event) => event.preventDefault());

// ---------- Init ----------

buildChordPicker();
buildPiano();
renderPads();
renderEditor();
updateHint();
updateControls();
