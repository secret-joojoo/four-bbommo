(() => {
'use strict';

const TYPE_META = {
  focus: { label: '집중', minutes: 25, tagClass: 'tag-accent', audio: 'audio-focus' },
  short: { label: '짧은 휴식', minutes: 5, tagClass: 'tag-neutral', audio: 'audio-short' },
  long: { label: '긴 휴식', minutes: 15, tagClass: 'tag-neutral', audio: 'audio-long' },
  custom: { label: '커스텀', minutes: null, tagClass: 'tag-neutral', audio: 'audio-custom' }
};
const CLASSIC_TEMPLATE = {
  id: 'classic', name: '뽀모도로의 정석', builtin: true, repeat: true,
  steps: ['focus', 'short', 'focus', 'short', 'focus', 'short', 'focus', 'long']
};
const THEMES = [
  { id: 'gold', name: '클래식 골드', accent: '#b68235' },
  { id: 'wine', name: '클래식 와인', accent: '#8a3540' },
  { id: 'forest', name: '클래식 포레스트', accent: '#35513f' },
  { id: 'navy', name: '모던 네이비', accent: '#26415e' },
  { id: 'graphite', name: '모던 그래파이트', accent: '#4a4a46' }
];

function themeVars(hex) {
  return {
    '--color-accent': hex,
    '--color-accent-100': `color-mix(in oklch, ${hex} 12%, white)`,
    '--color-accent-200': `color-mix(in oklch, ${hex} 24%, white)`,
    '--color-accent-300': `color-mix(in oklch, ${hex} 40%, white)`,
    '--color-accent-400': `color-mix(in oklch, ${hex} 65%, white)`,
    '--color-accent-500': hex,
    '--color-accent-600': `color-mix(in oklch, ${hex} 85%, black)`,
    '--color-accent-700': `color-mix(in oklch, ${hex} 72%, black)`,
    '--color-accent-800': `color-mix(in oklch, ${hex} 58%, black)`,
    '--color-accent-900': `color-mix(in oklch, ${hex} 45%, black)`
  };
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

const $ = (id) => document.getElementById(id);

let customTemplates = [];
try {
  const rawTpl = localStorage.getItem('fourbbommo_templates');
  if (rawTpl) {
    const custom = JSON.parse(rawTpl);
    if (Array.isArray(custom)) customTemplates = custom;
  }
} catch (e) {}

let initialTodayCount = 0;
try {
  const raw = localStorage.getItem('fourbbommo_count');
  if (raw) {
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (data.date === today) initialTodayCount = data.count;
  }
} catch (e) {}

let initialTheme = 'gold';
try {
  const savedTheme = localStorage.getItem('fourbbommo_theme');
  if (savedTheme && THEMES.some((t) => t.id === savedTheme)) initialTheme = savedTheme;
} catch (e) {}

const state = {
  activeTab: 'mode',
  pendingSeconds: 25 * 60,
  pendingType: 'focus',
  pendingTemplateId: null,
  inputMinutes: 25,
  inputSeconds: 0,
  timerState: 'idle',
  remainingSeconds: 25 * 60,
  totalSeconds: 25 * 60,
  currentType: 'focus',
  activeTemplate: null,
  todayCount: initialTodayCount,
  dragging: false,
  beeped: false,
  templates: [CLASSIC_TEMPLATE, ...customTemplates],
  builderOpen: false,
  builderName: '',
  builderSteps: [],
  builderRepeat: false,
  themeId: initialTheme,
  videoStatus: 'loading'
};

let tickInterval = null;

function clearTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function persistCount(count) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('fourbbommo_count', JSON.stringify({ date: today, count }));
  } catch (e) {}
}

function persistTemplates() {
  try {
    const customOnly = state.templates.filter((t) => !t.builtin);
    localStorage.setItem('fourbbommo_templates', JSON.stringify(customOnly));
  } catch (e) {}
}

function playEndingAudio(type) {
  const meta = TYPE_META[type] || TYPE_META.custom;
  const el = $(meta.audio);
  if (!el) return;
  try {
    el.currentTime = 0;
    el.play().catch(() => {});
  } catch (e) {}
}

// ---- video handling ----
// running_junwoo.mov is Apple ProRes 4444 with an alpha channel, which no
// browser can decode or render as video transparency. Color and the
// grayscale alpha matte are pre-transcoded (see assets/videos/README) into
// two separate plain H.264 files. Playing them back live as two <video>
// elements and compositing frame-by-frame turned out to be unreliable: a
// live decoder has no guarantee that "the frame showing right now" in the
// color stream and the matte stream are the same frame index, and on some
// hardware decoders they visibly drift, leaking a raw (premultiplied-black)
// color pixel past a matte edge that hasn't caught up yet.
//
// So instead of live playback, both files are fully decoded ONCE up front
// with WebCodecs (see decodeVideoFrames/loadRunnerFrames below), which
// exposes real per-frame indices — frame N of color is combined with frame N
// of matte, guaranteed, because we picked them out by index ourselves rather
// than trusting two decoders to agree on "now". The result is one array of
// pre-composited frames; playback is just picking frames[i] by elapsed time.
const RUNNER_DISPLAY_HEIGHT = 160;
const RUNNER_DPR = 3;
const RUNNER_FPS = 30;
const canvasRunnerRef = () => $('canvas-runner');

// The actual demux/decode/downscale/combine work all happens inside
// assets/decode-worker.js, off the main thread entirely — it's CPU-heavy
// (307 frames x 2 streams) and doing it on the main thread would either
// block the page or, interleaved via setTimeout-style chunking, still
// compete with everything else on that one thread. A dedicated worker gets
// its own core and never touches page responsiveness.
function loadRunnerFrames() {
  return new Promise((resolve, reject) => {
    const worker = new Worker('assets/decode-worker.js');
    worker.onmessage = (e) => {
      worker.terminate();
      if (!e.data.ok) { reject(new Error(e.data.error)); return; }
      const { count, dw, dh, buffers } = e.data;
      const frames = new Array(count);
      for (let i = 0; i < count; i++) frames[i] = new ImageData(new Uint8ClampedArray(buffers[i]), dw, dh);
      const canvas = canvasRunnerRef();
      canvas.width = dw;
      canvas.height = dh;
      canvas.style.width = (dw / RUNNER_DPR) + 'px';
      canvas.style.height = (dh / RUNNER_DPR) + 'px';
      resolve(frames);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    // Absolute URLs: a relative path resolves against the *worker's own*
    // script location (assets/decode-worker.js), not the page's, so a plain
    // 'assets/videos/...' would double up into 'assets/assets/videos/...'.
    worker.postMessage({
      colorUrl: new URL('assets/videos/running_junwoo_color.mp4', document.baseURI).href,
      matteUrl: new URL('assets/videos/running_junwoo_matte.mp4', document.baseURI).href,
      displayHeight: RUNNER_DISPLAY_HEIGHT,
      dpr: RUNNER_DPR
    });
  });
}

let runnerFrames = null;

function compositeLoop() {
  // Only paint while actually running — otherwise the idle runner sprite
  // sits at 0% and covers the start arch's poles.
  if (state.videoStatus === 'ready' && state.timerState === 'running' && runnerFrames && runnerFrames.length) {
    // The animation frame is derived from the timer's own elapsed time
    // (endAt/totalSeconds, set in startTimer/startTemplateStep below) rather
    // than a separately-ticked animation clock. That means starting the
    // timer before frame decoding finishes just works: once the frames
    // become ready, playback picks up wherever the countdown has already
    // reached instead of restarting from frame 0.
    const elapsedMs = Math.max(0, state.totalSeconds * 1000 - (endAt - Date.now()));
    const frameIndex = Math.floor((elapsedMs / 1000) * RUNNER_FPS) % runnerFrames.length;
    canvasRunnerRef().getContext('2d').putImageData(runnerFrames[frameIndex], 0, 0);
  }
  requestAnimationFrame(compositeLoop);
}

function loadVideos() {
  const timeout = setTimeout(() => {
    if (state.videoStatus === 'loading') { state.videoStatus = 'error'; render(); }
  }, 20000);
  loadRunnerFrames().then((frames) => {
    clearTimeout(timeout);
    runnerFrames = frames;
    state.videoStatus = 'ready';
    render();
  }).catch(() => {
    clearTimeout(timeout);
    state.videoStatus = 'error';
    render();
  });
  requestAnimationFrame(compositeLoop);
}

// ---- dial drag ----
function updateAngleFromEvent(e) {
  const svg = $('dial');
  const rect = svg.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  let totalSeconds = Math.round((angle / 360) * 3600);
  if (totalSeconds >= 3600) totalSeconds = 3599;
  if (totalSeconds < 5) totalSeconds = 0;
  state.pendingSeconds = totalSeconds;
  state.pendingType = null;
  state.pendingTemplateId = null;
  state.inputMinutes = Math.floor(totalSeconds / 60);
  state.inputSeconds = totalSeconds % 60;
  render();
}
function onDialPointerDown(e) {
  if (state.timerState !== 'idle') return;
  e.preventDefault();
  updateAngleFromEvent(e);
  state.dragging = true;
  render();
}
window.addEventListener('pointermove', (e) => { if (state.dragging) updateAngleFromEvent(e); });
window.addEventListener('pointerup', () => { if (state.dragging) { state.dragging = false; render(); } });

// ---- mode / template selection ----
function onSelectMode(type) {
  const meta = TYPE_META[type];
  const secs = meta.minutes * 60;
  state.pendingSeconds = secs;
  state.pendingType = type;
  state.pendingTemplateId = null;
  state.inputMinutes = meta.minutes;
  state.inputSeconds = 0;
  render();
}
function onInputMinutesChange(e) {
  const v = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0));
  state.inputMinutes = v;
  state.pendingSeconds = v * 60 + state.inputSeconds;
  state.pendingType = null;
  state.pendingTemplateId = null;
  render();
}
function onInputSecondsChange(e) {
  const v = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0));
  state.inputSeconds = v;
  state.pendingSeconds = state.inputMinutes * 60 + v;
  state.pendingType = null;
  state.pendingTemplateId = null;
  render();
}
function onSelectTemplate(id) {
  state.pendingTemplateId = id;
  render();
}

// ---- timer control ----
function onStart() {
  if (state.pendingTemplateId) {
    const tpl = state.templates.find((t) => t.id === state.pendingTemplateId);
    if (tpl) { startTemplateStep(tpl, 0); return; }
  }
  if (state.pendingSeconds > 0) { startTimer(state.pendingSeconds, state.pendingType || 'custom'); }
}

// Background tabs get their setInterval throttled hard (Chrome clamps to
// roughly once a minute once a tab's been hidden a while) — exactly when a
// focus timer is expected to keep running while the user works elsewhere.
// Counting down by decrementing once per tick would drift or stall badly
// under that throttling. Instead, track the absolute wall-clock timestamp
// the current step should end at, and recompute remainingSeconds from
// "endAt - now" on every tick: however late a throttled tick fires, the
// computed remaining time is still correct, and a big backgrounded gap just
// resolves in one jump instead of drifting.
let endAt = 0;

function startTimer(seconds, type) {
  clearTick();
  state.timerState = 'running';
  state.remainingSeconds = seconds;
  state.totalSeconds = seconds;
  state.currentType = type;
  state.activeTemplate = null;
  state.beeped = false;
  endAt = Date.now() + seconds * 1000;
  render();
  tickInterval = setInterval(tick, 1000);
}

function startTemplateStep(tpl, stepIndex) {
  const type = tpl.steps[stepIndex];
  const seconds = TYPE_META[type].minutes * 60;
  clearTick();
  state.timerState = 'running';
  state.remainingSeconds = seconds;
  state.totalSeconds = seconds;
  state.currentType = type;
  state.activeTemplate = { template: tpl, stepIndex };
  state.beeped = false;
  endAt = Date.now() + seconds * 1000;
  render();
  tickInterval = setInterval(tick, 1000);
}

function tick() {
  const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  // <= instead of === : a throttled/delayed tick can jump straight past the
  // exact 10-second mark, which would otherwise skip the ending sound.
  if (remaining <= 10 && !state.beeped) { playEndingAudio(state.currentType); state.beeped = true; }
  if (remaining <= 0) {
    handleComplete();
  } else {
    state.remainingSeconds = remaining;
  }
  render();
}

function handleComplete() {
  if (state.currentType === 'focus') {
    state.todayCount += 1;
    persistCount(state.todayCount);
  }
  if (state.activeTemplate) {
    const { template, stepIndex } = state.activeTemplate;
    let nextIndex = stepIndex + 1;
    if (nextIndex >= template.steps.length) {
      if (template.repeat) {
        nextIndex = 0;
      } else {
        clearTick();
        state.timerState = 'idle';
        state.remainingSeconds = 0;
        state.activeTemplate = null;
        state.beeped = false;
        return;
      }
    }
    const nextType = template.steps[nextIndex];
    const nextSeconds = TYPE_META[nextType].minutes * 60;
    state.remainingSeconds = nextSeconds;
    state.totalSeconds = nextSeconds;
    state.currentType = nextType;
    state.activeTemplate = { template, stepIndex: nextIndex };
    state.beeped = false;
    endAt = Date.now() + nextSeconds * 1000;
    return;
  }
  clearTick();
  state.timerState = 'idle';
  state.remainingSeconds = 0;
  state.beeped = false;
}

function onTogglePause() {
  if (state.timerState === 'running') {
    clearTick();
    state.timerState = 'paused';
  } else if (state.timerState === 'paused') {
    endAt = Date.now() + state.remainingSeconds * 1000;
    tickInterval = setInterval(tick, 1000);
    state.timerState = 'running';
  }
  render();
}

function onReset() {
  clearTick();
  state.timerState = 'idle';
  state.remainingSeconds = state.pendingSeconds;
  state.totalSeconds = state.pendingSeconds;
  state.activeTemplate = null;
  state.beeped = false;
  render();
}

// ---- theme ----
function onSelectTheme(id) {
  state.themeId = id;
  try { localStorage.setItem('fourbbommo_theme', id); } catch (e) {}
  render();
}

// ---- template builder ----
function onOpenBuilder() {
  state.builderOpen = true;
  state.builderName = '';
  state.builderSteps = [];
  state.builderRepeat = false;
  render();
}
function onCloseBuilder() { state.builderOpen = false; render(); }
function addBuilderStep(type) {
  state.builderSteps.push({ type, id: Date.now() + Math.random() });
  render();
}
function removeBuilderStep(id) {
  state.builderSteps = state.builderSteps.filter((s) => s.id !== id);
  render();
}
function onSaveTemplate() {
  if (state.builderSteps.length === 0) return;
  const name = state.builderName.trim() || '이름 없는 템플릿';
  const tpl = {
    id: 'custom-' + Date.now(), name, builtin: false,
    repeat: state.builderRepeat, steps: state.builderSteps.map((s) => s.type)
  };
  state.templates.push(tpl);
  state.builderOpen = false;
  persistTemplates();
  render();
}

// ---- rendering ----
function renderTheme() {
  const hex = (THEMES.find((t) => t.id === state.themeId) || THEMES[0]).accent;
  const vars = themeVars(hex);
  for (const k in vars) document.documentElement.style.setProperty(k, vars[k]);

  const wrap = $('theme-swatches');
  wrap.innerHTML = '';
  THEMES.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-swatch';
    btn.style.background = t.accent;
    btn.style.outline = '2px solid ' + (state.themeId === t.id ? 'var(--color-text)' : 'transparent');
    btn.setAttribute('aria-label', t.name);
    btn.title = t.name;
    btn.addEventListener('click', () => onSelectTheme(t.id));
    wrap.appendChild(btn);
  });
}

function renderDial() {
  const isIdle = state.timerState === 'idle';
  const activeSeconds = isIdle ? state.pendingSeconds : state.remainingSeconds;
  const angleDeg = Math.min(359.9, (activeSeconds / 3600) * 360);
  const rad = angleDeg * Math.PI / 180;
  const handleX = 150 + 130 * Math.sin(rad);
  const handleY = 150 - 130 * Math.cos(rad);
  const circumference = 2 * Math.PI * 130;
  const progressLength = circumference * (angleDeg / 360);

  const svg = $('dial');
  svg.classList.toggle('idle', isIdle);
  svg.classList.toggle('dragging', state.dragging);

  $('dial-progress').setAttribute('stroke-dasharray', progressLength.toFixed(1) + ' ' + circumference.toFixed(1));
  $('dial-handle-line').setAttribute('x2', handleX);
  $('dial-handle-line').setAttribute('y2', handleY);
  $('dial-handle').setAttribute('cx', handleX);
  $('dial-handle').setAttribute('cy', handleY);

  $('display-time').textContent = fmt(activeSeconds);

  let statusLabel = '준비';
  if (!isIdle) {
    const meta = TYPE_META[state.currentType] || TYPE_META.custom;
    statusLabel = state.timerState === 'paused' ? '일시정지 · ' + meta.label : meta.label;
  } else if (state.pendingTemplateId) {
    const tpl = state.templates.find((t) => t.id === state.pendingTemplateId);
    statusLabel = tpl ? tpl.name + ' 준비됨' : '준비';
  } else if (state.pendingType) {
    statusLabel = TYPE_META[state.pendingType].label + ' 준비됨';
  }
  $('status-label').textContent = statusLabel;

  const badge = $('template-badge');
  if (state.activeTemplate && !isIdle) {
    const { template, stepIndex } = state.activeTemplate;
    badge.hidden = false;
    badge.textContent = template.name + ' · ' + (stepIndex + 1) + '/' + template.steps.length + ' · ' + TYPE_META[template.steps[stepIndex]].label;
  } else {
    badge.hidden = true;
  }

  $('manual-input').hidden = !isIdle;
  $('input-minutes').value = state.inputMinutes;
  $('input-seconds').value = state.inputSeconds;

  $('btn-start').hidden = !isIdle;
  $('btn-pause').hidden = isIdle;
  $('btn-reset').hidden = isIdle;
  $('btn-pause').textContent = state.timerState === 'paused' ? '재시작' : '일시정지';
}

function renderModePanel() {
  const wrap = $('panel-mode');
  wrap.innerHTML = '';
  const isIdle = state.timerState === 'idle';
  ['focus', 'short', 'long'].forEach((type) => {
    const meta = TYPE_META[type];
    const active = isIdle && !state.pendingTemplateId && state.pendingType === type;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    btn.style.borderColor = active ? 'var(--color-accent)' : 'var(--color-divider)';
    btn.innerHTML = `<div class="card-kicker">모드</div><div class="card-title">${meta.label}</div><div class="card-meta"><span>${meta.minutes}분</span></div>`;
    btn.addEventListener('click', () => onSelectMode(type));
    wrap.appendChild(btn);
  });
}

function renderTemplatePanel() {
  const wrap = $('panel-template');
  wrap.innerHTML = '';
  const isIdle = state.timerState === 'idle';

  state.templates.forEach((tpl) => {
    const active = isIdle && state.pendingTemplateId === tpl.id;
    const card = document.createElement('div');
    card.className = 'card';
    card.style.borderColor = active ? 'var(--color-accent)' : 'var(--color-divider)';

    const seen = [];
    tpl.steps.forEach((st) => { if (seen[seen.length - 1] !== st) seen.push(st); });
    const chips = seen.slice(0, 8).map((st) => `<span class="tag ${TYPE_META[st].tagClass}">${TYPE_META[st].label}</span>`).join('');
    const repeatChip = tpl.repeat ? '<span class="tag tag-outline">무한 반복</span>' : '';

    card.innerHTML = `<div class="card-kicker">${tpl.builtin ? '기본 템플릿' : '내 템플릿'}</div>` +
      `<div class="card-title">${tpl.name}</div>` +
      `<div class="template-chips">${chips}${repeatChip}</div>`;
    card.addEventListener('click', () => onSelectTemplate(tpl.id));
    wrap.appendChild(card);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-ghost btn-block';
  addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg> 템플릿 만들기';
  addBtn.addEventListener('click', onOpenBuilder);
  wrap.appendChild(addBtn);
}

function renderTabs() {
  const isModeTab = state.activeTab === 'mode';
  $('tab-mode').checked = isModeTab;
  $('tab-template').checked = !isModeTab;
  $('panel-mode').hidden = !isModeTab;
  $('panel-template').hidden = isModeTab;
}

function renderBuilder() {
  $('builder-backdrop').hidden = !state.builderOpen;
  $('builder-name').value = state.builderName;
  $('builder-repeat').checked = state.builderRepeat;
  $('builder-save').disabled = state.builderSteps.length === 0;

  const wrap = $('builder-steps');
  wrap.innerHTML = '';
  state.builderSteps.forEach((step) => {
    const meta = TYPE_META[step.type];
    const row = document.createElement('div');
    row.className = 'builder-step-row';
    row.innerHTML = `<span>${meta.label} (${meta.minutes}분)</span>`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost btn-icon';
    removeBtn.setAttribute('aria-label', '삭제');
    removeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>';
    removeBtn.addEventListener('click', () => removeBuilderStep(step.id));
    row.appendChild(removeBtn);
    wrap.appendChild(row);
  });
}

function renderRunner() {
  // No idle-specific override: on a natural finish, remainingSeconds is 0
  // while totalSeconds still holds the run's full length, so this formula
  // already lands the runner at 100% (waiting at the finish line) instead of
  // snapping back to the start. Both onReset and the pre-start idle state
  // set remainingSeconds back to totalSeconds themselves, which the same
  // formula resolves to 0% — so no special-casing is needed either way.
  const runnerLeftPct = Math.min(100, Math.max(0, (1 - state.remainingSeconds / (state.totalSeconds || 1)) * 100));
  $('runner').style.left = runnerLeftPct + '%';

  // While frames are still decoding (or failed to), just leave this empty
  // rather than showing a placeholder icon — the runner appears the moment
  // it's actually ready to animate.
  canvasRunnerRef().style.display = state.videoStatus === 'ready' ? 'block' : 'none';
}

function renderTodayCount() {
  $('today-count').textContent = state.todayCount;
}

function render() {
  renderTheme();
  renderTodayCount();
  renderDial();
  renderTabs();
  renderModePanel();
  renderTemplatePanel();
  renderBuilder();
  renderRunner();
}

function renderGrass() {
  const grass = $('grass');
  [8, 20, 45, 57, 75, 88].forEach((left) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '26');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 26 22');
    svg.classList.add('grass-tuft');
    svg.style.left = left + '%';
    svg.innerHTML = `
      <ellipse cx="13" cy="21" rx="9" ry="1.5" fill="var(--color-neutral-900)" opacity="0.1"></ellipse>
      <circle cx="7" cy="15" r="6.5" fill="#8ea67d" stroke="#54614a" stroke-width="1"></circle>
      <circle cx="16" cy="13" r="8" fill="#9bb48a" stroke="#54614a" stroke-width="1"></circle>
      <circle cx="20" cy="16" r="5.5" fill="#7f9670" stroke="#54614a" stroke-width="1"></circle>`;
    grass.appendChild(svg);
  });
}

// ---- wire up static event listeners ----
function init() {
  renderGrass();
  loadVideos();

  $('dial').addEventListener('pointerdown', onDialPointerDown);
  $('input-minutes').addEventListener('change', onInputMinutesChange);
  $('input-seconds').addEventListener('change', onInputSecondsChange);
  $('btn-start').addEventListener('click', onStart);
  $('btn-pause').addEventListener('click', onTogglePause);
  $('btn-reset').addEventListener('click', onReset);

  $('tab-mode').addEventListener('change', () => { state.activeTab = 'mode'; render(); });
  $('tab-template').addEventListener('change', () => { state.activeTab = 'template'; render(); });

  $('add-focus').addEventListener('click', () => addBuilderStep('focus'));
  $('add-short').addEventListener('click', () => addBuilderStep('short'));
  $('add-long').addEventListener('click', () => addBuilderStep('long'));
  $('builder-name').addEventListener('input', (e) => { state.builderName = e.target.value; });
  $('builder-repeat').addEventListener('change', (e) => { state.builderRepeat = e.target.checked; });
  $('builder-cancel').addEventListener('click', onCloseBuilder);
  $('builder-save').addEventListener('click', onSaveTemplate);

  // A throttled background tab still self-corrects on its next tick (see
  // `endAt` above), but that could take up to a minute — catch up the
  // instant the tab is visible again instead of leaving a stale display.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.timerState === 'running') tick();
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
})();
