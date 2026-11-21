/**
 * 泰语同传 - 手机独立版
 *
 * 不依赖 Mac：手机直接连 Soniox 做实时识别、翻译、真人朗读。
 * 每场记录保存在手机上；结束后可一键分享给手机上的 Claude / ChatGPT / Grok
 * 生成会议纪要（整理要求自动附在前面）。
 *
 * 密钥只保存在这台手机的浏览器里，不在代码里。
 */

const SONIOX_WS = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_TTS = 'https://tts-rt.soniox.com/tts';
const SESSION_ROTATE_MS = 280 * 60 * 1000; // 单连接上限 300 分钟，提前续期
const GAP_NEW_UTT_MS = 1500;
const MAX_LOCAL_SESSIONS = 50;

const SPEAKER_COLORS = ['#c2410c', '#1d4ed8', '#15803d', '#7c3aed', '#be185d', '#0e7490', '#a16207', '#4338ca'];
const LANG_NAMES = { th: '泰语', en: '英语', zh: '中文', ja: '日语', ko: '韩语', vi: '越南语', ms: '马来语', km: '高棉语', my: '缅甸语', lo: '老挝语' };

const $ = id => document.getElementById(id);
const feed = $('feed'), live = $('live'), liveOrig = $('liveOriginal'), liveTrans = $('liveTranslation');

// ---------- 本机存储（读写都包 try，隐私模式下也不崩）----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const cfg = Object.assign(
  { sonioxKey: '', targetLang: 'zh', diarize: true, speak: false },
  load('cfg', {})
);
function saveCfg() { save('cfg', cfg); }

// ---------- 状态 ----------
const state = {
  running: false, demo: false, ws: null, audio: null,
  session: null,        // 当前这一场 {id, startedAt, updatedAt, targetLang, speakerNames, utterances[]}
  current: null,        // 正在累积的一句
  utterances: [],       // 屏幕上的句子（带 el）
  speakerNames: {},
  startTime: 0, timerHandle: null, rotateHandle: null,
  uttSeq: 0, fatalError: null, audioChunks: 0, gen: 0, diag: { sent: 0, peak: 0, msgs: 0, words: 0 }, watchHandle: null,
};

// ---------- 初始化 ----------
// 出错时直接在屏幕上提示，而不是“点了没反应”
window.addEventListener('error', e => toast('出错了：' + (e.message || '未知错误') + '（请关掉 App 重新打开）'));
window.addEventListener('unhandledrejection', e => toast('出错了：' + (e.reason?.message || e.reason || '未知错误')));

// 元素不存在时（新旧版本混用）也不崩
function on(id, fn) { const el = $(id); if (el) el.onclick = fn; }
function show(id, visible) { const el = $(id); if (el) el.hidden = !visible; }

function init() {
  on('btnStart', start);
  on('btnStop', stop);
  on('btnDemo', runDemo);
  on('btnDim', showDim);
  on('dim', hideDim);
  on('btnSpeak', toggleSpeak);
  on('btnSettings', openSettings);
  on('btnCloseSettings', () => $('dlgSettings').close());
  on('btnSaveSettings', saveSettings);
  on('btnHistory', openHistory);
  on('btnCloseHistory', () => $('dlgHistory').close());
  updateSpeakButton();
  updateEmptyHint();

  // 上次没结束的一场（比如中途刷新、手机杀后台）：恢复到屏幕上
  const pending = load('currentSession', null);
  if (pending && pending.utterances?.length) {
    state.session = pending;
    restoreSession(pending);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function updateEmptyHint() {
  const el = $('emptyHint');
  if (el) el.textContent = cfg.sonioxKey ? '' : '第一次使用：先点右上角 ⚙ 填入 Soniox 密钥。想先看效果可以点「演示」。';
}

// ---------- 设置 ----------
function openSettings() {
  $('selLang').value = cfg.targetLang;
  $('chkDiarize').checked = cfg.diarize !== false;
  $('inpKey').value = '';
  $('keyState').textContent = cfg.sonioxKey ? '✓ 已保存密钥（不需要修改就留空）' : '在 console.soniox.com 的 API Keys 页面复制';
  $('dlgSettings').showModal();
}

function saveSettings() {
  cfg.targetLang = $('selLang').value;
  cfg.diarize = $('chkDiarize').checked;
  const key = $('inpKey').value.trim();
  if (key) cfg.sonioxKey = key;
  saveCfg();
  $('dlgSettings').close();
  updateEmptyHint();
  toast('设置已保存');
}

// ---------- 询问弹窗 ----------
function askDialog(title, text, yesLabel, noLabel) {
  return new Promise(resolve => {
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    $('askYes').textContent = yesLabel;
    $('askNo').textContent = noLabel;
    $('askNo').hidden = !noLabel;
    const dlg = $('dlgAsk');
    $('askYes').onclick = () => { dlg.close(); resolve(true); };
    $('askNo').onclick = () => { dlg.close(); resolve(false); };
    dlg.showModal();
  });
}

// ---------- 开始 / 结束 ----------
async function start() {
  if (state.running) return;
  if (!cfg.sonioxKey) {
    toast('请先填入 Soniox 密钥');
    openSettings();
    return;
  }
  if (state.session?.utterances?.length) {
    const cont = await askDialog(
      '继续上一场，还是开新对话？',
      '继续：新内容接在后面，算同一场。开新对话：清空屏幕重新开始（上一场已保存在历史记录里）。',
      '▶ 继续上一场', '✦ 开新对话'
    );
    if (!cont) resetConversation();
  } else {
    resetConversation(); // 清掉演示留下的内容
  }
  // 朗读需要在用户点按时“解锁”一次声音（手机浏览器的限制）
  unlockAudio();
  // 必须在点按的当下创建并启动声音处理，否则安卓 Chrome 会让它“静音挂起”，Soniox 收不到声音
  const ctx = newAudioContext();
  closeSoniox();
  cleanupAudio();
  setStatus('connecting', '连接中…');
  try {
    await openMic(ctx);
    await withTimeout(openSoniox(), 15000, '连接超时，请检查网络');
    beginSession(false);
  } catch (e) {
    state.running = false;
    closeSoniox();
    setStatus('idle', '未开始');
    cleanupAudio();
    toast(e.message === 'mic' ? '无法使用麦克风：请在浏览器设置里允许这个网页使用麦克风' : '连接失败：' + e.message);
  }
}

function beginSession(isDemo) {
  state.gen++;
  state.running = true;
  state.demo = isDemo;
  state.startTime = Date.now();
  if (!state.session) newSessionRecord();
  $('empty')?.remove();
  show('btnStart', false);
  show('btnStop', true);
  show('btnDemo', false);
  show('btnDim', true);
  show('timer', true);
  live.hidden = false;
  setStatus('recording', isDemo ? '演示中' : '同传中');
  state.timerHandle = setInterval(updateTimer, 1000);
  acquireWakeLock();
  if (!isDemo) {
    // 5 秒后检查：麦克风到底有没有声音送出去
    state.audioChunks = 0;
    clearTimeout(state.watchHandle);
    state.diag = { sent: 0, peak: 0, msgs: 0, words: 0, maxPeak: 0 };
    state.watchHandle = setTimeout(() => {
      if (!state.running || state.demo) return;
      const d = state.diag;
      if (state.audioChunks === 0) {
        const st = state.audio?.ctx?.state;
        state.audio?.ctx?.resume?.().catch(() => {});
        toast(`⚠️ 麦克风没有声音进来（${st || '无'}）。请点「结束」再点「开始」；还不行请截图给我`);
      } else if (d.maxPeak < 1) {
        toast('⚠️ 麦克风收到的是静音。如果连着蓝牙耳机，可能用的是耳机的麦克风；请先断开耳机再试');
      } else if (d.sent === 0) {
        toast('⚠️ 声音没能送到翻译服务，请检查网络');
      }
    }, 8000);
  }
  if (!isDemo) state.rotateHandle = setTimeout(rotateSession, SESSION_ROTATE_MS);
}

async function stop() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.timerHandle);
  clearTimeout(state.rotateHandle);
  clearTimeout(state.watchHandle);
  state.fatalError = null;
  reconnecting = false;
  recoveringAudio = false;
  closeSoniox();
  cleanupAudio();
  releaseWakeLock();
  stopSpeaking();
  flushCurrent();
  setStatus('idle', '已结束');
  show('btnStart', true);
  show('btnStop', false);
  show('btnDemo', true);
  show('btnDim', false);
  hideDim();
  live.hidden = true;
  liveOrig.textContent = '';
  liveTrans.textContent = '';
  if (state.demo) return; // 演示不保存

  if (state.session?.utterances?.length) {
    archiveSession(state.session);
    const s = state.session;
    const want = await askDialog(
      '需要生成会议纪要吗？',
      `本场 ${s.utterances.length} 句已保存到历史记录。点「生成纪要」会打开分享菜单，选 Claude、ChatGPT 或 Grok，整理要求已经自动附上，发送即可。`,
      '📝 生成纪要', '不用了'
    );
    if (want) shareSession(s, true);
  }
}

function resetConversation() {
  state.session = null;
  state.utterances = [];
  state.current = null;
  state.speakerNames = {};
  state.uttSeq = 0;
  for (const k of Object.keys(nameColors)) delete nameColors[k];
  nameColorSeq = 0;
  feed.innerHTML = '';
  save('currentSession', null);
}

// ---------- 场次记录 ----------
function newSessionRecord() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  state.session = {
    id: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: now.getTime(),
    updatedAt: now.getTime(),
    targetLang: cfg.targetLang,
    speakerNames: {},
    utterances: [],
  };
}

function persistCurrent() {
  if (!state.session || state.demo) return;
  state.session.updatedAt = Date.now();
  state.session.speakerNames = { ...state.speakerNames };
  save('currentSession', state.session);
}

// 结束一场：放进历史列表（同一场继续后再结束，会覆盖旧的那条）
function archiveSession(s) {
  const list = load('sessions', []);
  const i = list.findIndex(x => x.id === s.id);
  const rec = { ...s, endedAt: Date.now() };
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  save('sessions', list.slice(0, MAX_LOCAL_SESSIONS));
  save('currentSession', state.session); // 保留，便于“继续上一场”
}

function restoreSession(s) {
  $('empty')?.remove();
  state.speakerNames = { ...(s.speakerNames || {}) };
  for (const r of s.utterances) {
    const u = { id: 'u' + (++state.uttSeq), speaker: r.speaker, lang: r.lang, original: r.original, translation: r.translation, el: null };
    u.el = createUttEl(u);
    state.utterances.push(u);
    updateUttEl(u);
  }
}

// ---------- 麦克风 ----------
function newAudioContext() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});
  return ctx;
}

async function openMic(ctx) {
  ctx = ctx || newAudioContext();
  let stream;
  const constraints = { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    try {
      await sleep(800); // 有的手机上一场的麦克风还没完全释放，稍等再试一次
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      try { ctx.close(); } catch {}
      throw new Error('mic');
    }
  }
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = (e) => {
    state.audioChunks++;
    // 记录音量（诊断用）：取这一包里最大的振幅
    const pcm = new Int16Array(e.data);
    let pk = 0;
    for (let i = 0; i < pcm.length; i += 4) { const v = Math.abs(pcm[i]); if (v > pk) pk = v; }
    state.diag.peak = Math.max(state.diag.peak * 0.85, pk / 327.68);
    if (state.ws && state.ws.readyState === WebSocket.OPEN) { state.ws.send(e.data); state.diag.sent++; }
  };
  src.connect(node);
  // 接一个静音输出，确保手机浏览器真的在运行这条声音处理线路
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  state.audio = { ctx, stream, node };
  // 系统中途收回麦克风（比如锁屏、来电）：同传还在进行就自动重新接上
  stream.getAudioTracks().forEach(t => { t.onended = () => { if (state.running && !state.demo && state.audio?.stream === stream) recoverAudio(); }; });
}

function cleanupAudio() {
  if (!state.audio) return;
  try { state.audio.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { state.audio.ctx.close(); } catch {}
  state.audio = null;
}

// ---------- Soniox 实时识别 + 翻译 ----------
function openSoniox() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SONIOX_WS);
    let opened = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        api_key: cfg.sonioxKey,
        model: 'stt-rt-v4',
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        enable_speaker_diarization: cfg.diarize !== false,
        enable_language_identification: true,
        enable_endpoint_detection: true,
        language_hints: ['th', 'en', 'zh'],
        translation: { type: 'one_way', target_language: cfg.targetLang },
      }));
      opened = true;
      state.ws = ws;
      resolve();
    };
    ws.onmessage = (e) => {
      if (state.ws !== ws) return; // 旧连接的消息，不要混进新对话
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      state.diag.msgs++;
      if (msg.tokens) state.diag.words += msg.tokens.filter(t => t.text && t.text.trim() && t.text[0] !== '<').length;
      if (msg.error_code) {
        if ([401, 402, 403].includes(msg.error_code)) { state.fatalError = msg.error_code; return; }
        toast(`识别服务出错 (${msg.error_code}): ${msg.error_message || ''}`);
        return;
      }
      if (msg.tokens?.length) handleTokens(msg.tokens);
    };
    ws.onerror = () => { if (!opened) reject(new Error('无法连接 Soniox，请检查网络')); };
    ws.onclose = () => {
      if (opened && state.ws !== ws) return; // 已经换了新连接，旧的关掉不用管
      if (state.ws === ws) state.ws = null;
      if (state.fatalError && state.running) {
        const code = state.fatalError;
        state.fatalError = null;
        cleanupAudio();
        setStatus('idle', code === 402 ? '余额不足' : '密钥无效');
        askDialog(
          code === 402 ? '⚠️ Soniox 余额用完了' : '⚠️ Soniox 密钥无效',
          code === 402
            ? '请到 console.soniox.com 点「Add funds」充值。充值后点「开始」，选「继续上一场」即可接着记，刚才的内容不会丢。'
            : '请到 console.soniox.com 的 API Keys 页面检查密钥，然后在 ⚙ 设置里重新粘贴。',
          '知道了', ''
        ).then(() => stop());
        return;
      }
      // 意外断线（比如网络切换）：自动重连
      if (state.running && !state.demo) reconnectSoniox();
    };
  });
}

function closeSoniox() {
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.onclose = null; ws.onmessage = null; ws.onerror = null;
    try { ws.send(''); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} }, 1500);
  }
}

async function rotateSession() {
  if (!state.running || state.demo) return;
  const old = state.ws;
  state.ws = null;
  try { if (old) { old.onclose = null; old.send(''); setTimeout(() => old.close(), 2000); } } catch {}
  state.rotateHandle = setTimeout(rotateSession, SESSION_ROTATE_MS);
  await reconnectSoniox(); // 与断线重连共用同一套逻辑，避免同时开两条连接
}

// ---------- 处理识别结果（与电脑版相同的逻辑）----------
function handleTokens(tokens) {
  let pOrig = '', pTrans = '';
  for (const t of tokens) {
    if (t.text === '<end>' || t.text === '<fin>') {
      if (t.is_final) flushCurrent();
      continue;
    }
    const isTranslation = t.translation_status === 'translation';
    if (t.is_final) appendFinal(t, isTranslation);
    else if (isTranslation) pTrans += t.text;
    else pOrig += t.text;
  }
  liveOrig.textContent = pOrig;
  liveTrans.textContent = pTrans;
  renderCurrent();
}

function appendFinal(t, isTranslation) {
  const speaker = t.speaker != null ? String(t.speaker) : (state.current ? state.current.speaker : '1');
  const needNew =
    !state.current ||
    speaker !== state.current.speaker ||
    (!isTranslation && t.start_ms != null && state.current.endMs != null && t.start_ms - state.current.endMs > GAP_NEW_UTT_MS);

  if (needNew && !isTranslation) {
    flushCurrent();
    state.current = {
      id: 'u' + (++state.uttSeq), speaker, lang: t.language || null,
      original: '', translation: '', el: null, endMs: null,
    };
  }
  if (!state.current) return;
  if (isTranslation) {
    state.current.translation += t.text;
  } else {
    state.current.original += t.text;
    if (t.language && !state.current.lang) state.current.lang = t.language;
    if (t.end_ms != null) state.current.endMs = t.end_ms;
  }
}

function flushCurrent() {
  const u = state.current;
  if (!u) return;
  state.current = null;
  u.original = u.original.trim();
  u.translation = u.translation.trim();
  if (!u.original) { u.el?.remove(); return; }
  if (!u.el) u.el = createUttEl(u);
  state.utterances.push(u);
  updateUttEl(u);
  if (state.session && !state.demo) {
    state.session.utterances.push({ speaker: u.speaker, lang: u.lang, original: u.original, translation: u.translation });
    persistCurrent();
  }
  if ($('dim') && !$('dim').hidden && $('dimText')) $('dimText').textContent = u.translation || u.original;
  speakUtterance(u);
}

// ---------- 渲染 ----------
function renderCurrent() {
  const u = state.current;
  if (!u || !u.original.trim()) return;
  if (!u.el) u.el = createUttEl(u);
  updateUttEl(u);
}

function nearBottom(px) { return feed.scrollHeight - feed.scrollTop - feed.clientHeight < px; }

function createUttEl(u) {
  const el = document.createElement('div');
  el.className = 'utt';
  el.innerHTML = `
    <div class="utt-head"><span class="chip"></span><span class="lang-tag" hidden></span></div>
    <div class="utt-original"></div>
    <div class="utt-translation"></div>`;
  el.querySelector('.chip').onclick = () => renameSpeaker(u.speaker);
  const stick = nearBottom(150);
  feed.appendChild(el);
  if (stick) feed.scrollTop = feed.scrollHeight;
  return el;
}

function updateUttEl(u) {
  if (!u.el) return;
  const chip = u.el.querySelector('.chip');
  chip.textContent = speakerName(u.speaker);
  chip.style.background = speakerColor(u.speaker);
  const langTag = u.el.querySelector('.lang-tag');
  if (u.lang) { langTag.hidden = false; langTag.textContent = LANG_NAMES[u.lang] || u.lang; }
  u.el.querySelector('.utt-original').textContent = u.original;
  u.el.querySelector('.utt-translation').textContent =
    u.translation || (u.lang === cfg.targetLang ? u.original : '…');
  if (nearBottom(220)) feed.scrollTop = feed.scrollHeight;
}

function speakerName(s) { return state.speakerNames[s] || `说话人 ${s}`; }

const nameColors = {};
let nameColorSeq = 0;
function speakerColor(s) {
  const key = speakerName(s);
  if (!(key in nameColors)) nameColors[key] = SPEAKER_COLORS[nameColorSeq++ % SPEAKER_COLORS.length];
  return nameColors[key];
}

function renameSpeaker(s) {
  const name = prompt(`给「${speakerName(s)}」起个名字（比如 Somchai / 老板 / 我）：`, state.speakerNames[s] || '');
  if (name === null) return;
  state.speakerNames[s] = name.trim();
  state.utterances.forEach(u => { if (u.speaker === s) updateUttEl(u); });
  if (state.current?.speaker === s) renderCurrent();
  persistCurrent();
}

// ---------- 朗读：Soniox 真人语音，失败时用手机自带语音 ----------
let speakQueue = [];
let speakPlaying = false;
const speakAudio = new Audio();

function unlockAudio() {
  // 手机浏览器要求声音必须由一次点按触发；在点「开始/朗读」时先播一段静音
  try {
    speakAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    speakAudio.play().catch(() => {});
  } catch {}
}

function toggleSpeak() {
  cfg.speak = !cfg.speak;
  saveCfg();
  updateSpeakButton();
  if (cfg.speak) {
    unlockAudio();
    enqueueSpeak(cfg.targetLang === 'zh' ? '朗读已开启' : 'Read aloud is on');
    toast('🔊 朗读已开启（建议戴耳机）');
  } else {
    stopSpeaking();
    toast('🔇 朗读已关闭');
  }
}

function updateSpeakButton() {
  const b = $('btnSpeak');
  b.innerHTML = `${cfg.speak ? '🔊' : '🔇'}<span>朗读</span>`;
  b.classList.toggle('active', !!cfg.speak);
}

function stopSpeaking() {
  speakQueue = [];
  speakPlaying = false;
  try { speakAudio.pause(); } catch {}
  try { speechSynthesis?.cancel(); } catch {}
}

function enqueueSpeak(text) {
  if (!text) return;
  speakQueue.push(text);
  if (speakQueue.length > 3) speakQueue = speakQueue.slice(-3); // 跟不上时只读最新的
  if (!speakPlaying) playNextSpeak();
}

async function playNextSpeak() {
  if (!cfg.speak || !speakQueue.length) { speakPlaying = false; return; }
  speakPlaying = true;
  const text = speakQueue.shift();
  const lang = cfg.targetLang === 'en' ? 'en' : 'zh';
  try {
    if (!cfg.sonioxKey) throw new Error('no key');
    const r = await fetch(SONIOX_TTS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.sonioxKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-rt-v1', text, voice: 'Adrian', language: lang, audio_format: 'mp3' }),
    });
    if (!r.ok) throw new Error('tts ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    speakAudio.onended = () => { URL.revokeObjectURL(url); playNextSpeak(); };
    speakAudio.onerror = () => { URL.revokeObjectURL(url); browserSpeak(text, playNextSpeak); };
    speakAudio.src = url;
    await speakAudio.play();
  } catch {
    browserSpeak(text, playNextSpeak);
  }
}

function browserSpeak(text, done) {
  if (!('speechSynthesis' in window)) { done(); return; }
  try {
    const ut = new SpeechSynthesisUtterance(text);
    ut.lang = cfg.targetLang === 'zh' ? 'zh-CN' : 'en-US';
    ut.onend = ut.onerror = () => done();
    speechSynthesis.speak(ut);
  } catch { done(); }
}

function speakUtterance(u) {
  if (!cfg.speak || !state.running) return;
  if (u.lang === cfg.targetLang) return; // 本来就听得懂，不重复读
  if (u.translation) enqueueSpeak(u.translation);
}

// ---------- 历史记录 ----------
function openHistory() {
  const box = $('historyList');
  const list = load('sessions', []);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="note">还没有记录。每场同传结束后会保存在这里。</p>';
  }
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const d = new Date(s.startedAt);
    const firstLine = s.utterances[0]?.translation || s.utterances[0]?.original || '';
    item.innerHTML = `
      <div><b>${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</b></div>
      <div class="meta">${s.utterances.length} 句</div>
      <div class="preview"></div>
      <div class="acts">
        <button data-act="ai" class="primary">📝 生成纪要</button>
        <button data-act="view">查看</button>
        <button data-act="share">分享原文</button>
        <button data-act="file">💾 存文件</button>
        <button data-act="del">删除</button>
      </div>`;
    item.querySelector('.preview').textContent = firstLine.slice(0, 60);
    item.querySelector('[data-act=ai]').onclick = () => shareSession(s, true);
    item.querySelector('[data-act=view]').onclick = () => viewSession(s);
    item.querySelector('[data-act=share]').onclick = () => shareSession(s, false);
    item.querySelector('[data-act=file]').onclick = () => saveSessionFile(s);
    item.querySelector('[data-act=del]').onclick = () => {
      if (!confirm('从这台手机上删除这条记录？删除后无法恢复。')) return;
      save('sessions', load('sessions', []).filter(x => x.id !== s.id));
      openHistory();
    };
    box.appendChild(item);
  }
  if (!$('dlgHistory').open) $('dlgHistory').showModal();
}

function viewSession(s) {
  if (state.running) { toast('请先结束当前同传'); return; }
  $('dlgHistory').close();
  resetConversation();
  state.session = { ...s, utterances: [...s.utterances] };
  restoreSession(s);
  save('currentSession', state.session);
  toast('已打开这场记录；点「开始」可选择接着记');
}

function sessionText(s) {
  const names = s.speakerNames || {};
  const d = new Date(s.startedAt);
  return `泰语同传记录 ${d.toLocaleString('zh-CN')}\n\n` + s.utterances.map(u =>
    `【${names[u.speaker] || '说话人 ' + u.speaker}】${u.original}\n→ ${u.translation || u.original}`
  ).join('\n\n');
}

// 存成文本文件到手机的“下载”文件夹：清理浏览器数据也不会丢
function saveSessionFile(s) {
  const blob = new Blob([sessionText(s)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `泰语同传-${s.id.slice(0, 15)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已保存到手机的「下载」文件夹（文件管理里能看到）');
}

// 发给 Claude / ChatGPT / Grok 时附在最前面的整理要求
function minutesPrompt(s) {
  const lang = s.targetLang === 'en' ? 'English' : '中文';
  return `请把下面这段多语言会议（泰语/英语/中文混说）的实时转写整理成会议纪要，用${lang}写：
1. 开头用 3-6 句话概括要点：讨论了什么、结论、待办事项（谁、做什么、什么时候）
2. 按时间顺序整理对话：结合上下文修正机器翻译的错误、补全省略的指代，同一人连续说的话合并成段
3. 保留关键数字、日期、人名、地名，前后统一
4. 最后列出本场最值得学的 3 个泰语词或短语：泰文、拼音（带声调）、中文意思、一句用法说明

转写内容（每段格式：【说话人】原文 → 机器译文）：

`;
}

async function shareSession(s, forMinutes) {
  const text = (forMinutes ? minutesPrompt(s) : '') + sessionText(s);
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) {
    if (e?.name === 'AbortError') return; // 用户自己取消了分享
  }
  // 不支持分享菜单时：复制到剪贴板，自己粘贴到 AI 里
  try {
    await navigator.clipboard.writeText(text);
    toast(forMinutes ? '已复制（含整理要求），打开 Claude / ChatGPT / Grok 粘贴发送即可' : '已复制到剪贴板');
  } catch {
    toast('这个浏览器不支持分享和复制');
  }
}

// ---------- 演示（不用麦克风和密钥）----------
async function runDemo() {
  if (state.running) return;
  resetConversation();
  unlockAudio();
  beginSession(true);
  const tgt = cfg.targetLang === 'en' ? 'en' : 'zh';
  const script = [
    { sp: '1', lang: 'th', orig: 'สวัสดีครับ วันนี้เรามาคุยเรื่องกำหนดการเปิดร้านสาขาใหม่ที่สยามนะครับ',
      zh: '大家好，今天我们来谈一下暹罗新分店的开业时间安排。', en: 'Hello everyone, today let us discuss the opening schedule for the new branch at Siam.' },
    { sp: '2', lang: 'en', orig: 'Sure. The renovation should be done by the end of this month, but the permit is still pending.',
      zh: '好的。装修这个月底应该能完成，但许可证还在审批中。', en: '' },
    { sp: '1', lang: 'th', orig: 'เรื่องใบอนุญาต ผมจะตามให้ภายในศุกร์นี้ครับ',
      zh: '许可证的事，我这周五之前去跟进。', en: 'As for the permit, I will follow up on it by this Friday.' },
    { sp: '3', lang: 'zh', orig: '那我这边先把设备订了，到货大概要两周。',
      zh: '', en: 'Then I will order the equipment first; delivery takes about two weeks.' },
  ];
  for (const line of script) {
    for (let i = 1; i <= line.orig.length; i += 4) {
      if (!state.running) return;
      liveOrig.textContent = line.orig.slice(0, i);
      await sleep(45);
    }
    const tokens = [{ text: line.orig, is_final: true, speaker: line.sp, language: line.lang, translation_status: 'original', start_ms: 0, end_ms: 0 }];
    if (line.lang !== tgt) tokens.push({ text: line[tgt], is_final: true, speaker: line.sp, translation_status: 'translation' });
    tokens.push({ text: '<end>', is_final: true });
    handleTokens(tokens);
    liveOrig.textContent = '';
    await sleep(1000);
  }
  if (state.running) toast('演示结束，点「结束」退出演示');
}

// ---------- 小工具 ----------
function setStatus(cls, text) {
  const el = $('status');
  el.className = 'status ' + cls;
  el.querySelector('b').textContent = text;
}

function updateTimer() {
  const s = Math.floor((Date.now() - state.startTime) / 1000);
  const d = state.diag, el = $('diag');
  if (d) d.maxPeak = Math.max(d.maxPeak || 0, d.peak);
  if (el && !state.demo) {
    const bars = d.peak < 1 ? '▁' : d.peak < 5 ? '▂' : d.peak < 15 ? '▄' : d.peak < 40 ? '▆' : '█';
    el.textContent = `🎙${bars} ${Math.round(d.peak)}% · 发出 ${d.sent} · 收到 ${d.msgs}/${d.words}词 · ${state.ws ? '已连接' : '未连接'} · ${state.audio?.ctx?.state || '-'}`;
  } else if (el) el.textContent = '';
  $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let toastHandle;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.remove(), 3500);
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 防熄屏 + 熄屏后自动恢复 ----------
let wakeLock = null;
let wakeWarned = false;

async function acquireWakeLock() {
  document.addEventListener('visibilitychange', onVisibility);
  await requestWakeLock();
}

async function requestWakeLock() {
  try {
    if (!navigator.wakeLock) throw new Error('unsupported');
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // 手机不允许网页保持常亮：明确告诉用户，而不是默默熄屏
    if (!wakeWarned && document.visibilityState === 'visible') {
      wakeWarned = true;
      toast('⚠️ 手机没允许保持常亮：请把手机"自动锁屏"时间调长，开会时可用 🌙 暗屏');
    }
  }
}

// 屏幕重新点亮 / 切回 App 时：重新申请常亮，并检查收音和连接是否还活着
async function onVisibility() {
  if (document.visibilityState !== 'visible' || !state.running) return;
  await requestWakeLock();
  checkHealth();
}

function checkHealth() {
  if (!state.running || state.demo) return;
  const a = state.audio;
  const micDead = !a || a.stream.getAudioTracks().every(t => t.readyState === 'ended');
  if (micDead) recoverAudio();
  else if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
  if (!state.ws) reconnectSoniox();
}

function releaseWakeLock() {
  document.removeEventListener('visibilitychange', onVisibility);
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

// 麦克风被系统收回后重新打开
let recoveringAudio = false;
async function recoverAudio() {
  if (recoveringAudio || !state.running) return;
  recoveringAudio = true;
  try {
    cleanupAudio();
    await openMic();
    toast('🎙 已恢复收音');
  } catch {
    toast('⚠️ 麦克风被系统收回了，点亮屏幕后会自动再试');
  }
  recoveringAudio = false;
}

// 断网或连接中断：一直重试，直到连上或用户点结束（开会时网络可能短暂掉线）
let reconnecting = false;
async function reconnectSoniox() {
  if (reconnecting) return;
  reconnecting = true;
  setStatus('connecting', '重连中…');
  let delay = 1000;
  const gen = state.gen;
  while (state.running && !state.ws && state.gen === gen) {
    await sleep(delay);
    if (!state.running || state.ws) break;
    try {
      await openSoniox();
      setStatus('recording', '同传中');
    } catch {
      delay = Math.min(delay * 2, 10000);
    }
  }
  reconnecting = false;
  if (state.running && state.ws && state.gen === gen) setStatus('recording', '同传中');
}

// ---------- 暗屏：全黑像熄屏，同传照常 ----------
function showDim() {
  const last = state.utterances[state.utterances.length - 1];
  if ($('dimText')) $('dimText').textContent = last ? (last.translation || last.original) : '';
  show('dim', true);
}
function hideDim() { show('dim', false); }

// 放在文件最后再启动：保证所有变量都已准备好
init();
