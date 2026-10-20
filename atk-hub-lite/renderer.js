let dev = null;
let busy = false;
let connecting = false;
let state = null;
let timer = null;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- protocol ----
const frame = (cmd, data = []) => {
  const p = new Uint8Array(16);
  p[0] = cmd;
  data.forEach((b, i) => p[1 + i] = b);
  let sum = 0x08;
  for (let i = 0; i < 15; i++) sum += p[i];
  p[15] = (0x55 - (sum & 0xff)) & 0xff;
  return p;
};
const checksumOk = f => ((f.slice(0, 15).reduce((a, b) => a + b, 0) + 0x08 + f[15]) & 0xff) === 0x55;
const pairOk = (a, b) => ((a + b) & 0xff) === 0x55;

const askRaw = (cmd, data, match = () => true) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { dev.removeEventListener('inputreport', on); reject(new Error('timeout')); }, 1500);
  const on = e => {
    if (e.reportId !== 8) return;
    const f = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (f[0] !== cmd || !checksumOk(f) || !match(f)) return;
    clearTimeout(t); dev.removeEventListener('inputreport', on); resolve(f);
  };
  dev.addEventListener('inputreport', on);
  dev.sendReport(8, frame(cmd, data));
});
let queue = Promise.resolve();
const ask = (...args) => (queue = queue.catch(() => {}).then(() => askRaw(...args)));

const readBlock = async (addr, len) => {
  const f = await ask(0x08, [0, addr >> 8, addr & 0xff, len], f => f[2] === (addr >> 8) && f[3] === (addr & 0xff));
  return Array.from(f.slice(5, 5 + len));
};
const readRetry = async (addr, len, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    try { return await readBlock(addr, len); } catch { await sleep(300); }
  }
  throw new Error('no reply after ' + tries + ' tries');
};

// Write, wait, read back, roll back on mismatch.
const writeBlock = async (addr, bytes) => {
  if (bytes.length > 10) throw new Error('max 10 bytes per write');
  const before = await readRetry(addr, bytes.length);
  const send = b => dev.sendReport(8, frame(0x07, [0, addr >> 8, addr & 0xff, b.length, ...b]));
  await send(bytes);
  await sleep(400);
  const after = await readRetry(addr, bytes.length);
  if (after.some((b, i) => b !== bytes[i])) {
    await send(before);
    await sleep(400);
    throw new Error('Readback did not match; previous value restored');
  }
  return { before, after };
};

// ---- decoding / encoding ----
const SKIP = new Set([7,13,20,26,33,40,46,53,60,66,73,80,86,93,100,106,113,120,126,133,140,146,153,160,166,173,180,186,193,200,206,213,220,226,233]);
const CODES = Array.from({ length: 235 }, (_, i) => i + 1).filter(c => !SKIP.has(c));
const decodeAxis = (code, nib) => {
  if (nib & ~2) return null;
  const i = CODES.indexOf(code);
  if (i < 0) return null;
  const base = (i + 1) * 50;
  return (nib & 2) ? (base > 5000 ? base * 2 : null) : base;
};
const decodeStage = d => {
  if (d.reduce((a, b) => a + b, 0) % 256 !== 0x55) return null;
  const x = decodeAxis(d[0], d[2] & 0x0f), y = decodeAxis(d[1], d[2] >> 4);
  return x === null || y === null ? null : { x, y };
};
const encodeAxis = dpi => {
  const doubled = dpi > 10000;
  const base = doubled ? dpi / 2 : dpi;
  if (!Number.isInteger(base) || base < 50 || base > 10000 || base % 50 !== 0) return null;
  const code = CODES[base / 50 - 1];
  return code === undefined ? null : { byte: code, nib: doubled ? 2 : 0 };
};
const encodeStage = dpi => {
  const a = encodeAxis(dpi);
  if (!a) return null;
  const mode = (a.nib << 4) | a.nib;
  const chk = (0x55 - ((a.byte + a.byte + mode) & 0xff)) & 0xff;
  return [a.byte, a.byte, mode, chk];
};
const POLL = { 1: 1000, 2: 500, 4: 250, 8: 125 };
const POLL_CODES = { 125: 0x08, 250: 0x04, 500: 0x02, 1000: 0x01 };

// ---- known connections ----
const KNOWN = [
  { vid: 0x3554, pid: 0xf58f, kind: 'wired' },
  { vid: 0x373b, pid: 0x1085, kind: 'dongle' },
];
const known = d => KNOWN.find(k => k.vid === d.vendorId && k.pid === d.productId);
const isConfig = d => d.collections.some(c => c.usagePage === 0xff02 && c.usage === 0x02);
const requireWritable = () => {
  if (!dev || !known(dev)) throw new Error('Writes are not enabled for this connection.');
};

// ---- writes ----
async function setStageDpi(index, dpi) {
  requireWritable();
  if (!Number.isInteger(dpi) || dpi < 200 || dpi > 10000 || dpi % 50 !== 0) {
    throw new Error('DPI must be 200-10000 in steps of 50');
  }
  const sys = await readRetry(0x0000, 6);
  const count = Math.min(Math.max(sys[2], 1), 8);
  if (index < 0 || index >= count) throw new Error('No such stage');
  const bytes = encodeStage(dpi);
  const back = bytes && decodeStage(bytes);
  if (!back || back.x !== dpi) throw new Error('Cannot encode that DPI');
  await writeBlock(0x000c + index * 4, bytes);
}
async function setActiveStage(index) {
  requireWritable();
  const sys = await readRetry(0x0000, 6);
  const count = Math.min(Math.max(sys[2], 1), 8);
  if (index < 0 || index >= count) throw new Error('No such stage');
  await writeBlock(0x0004, [index, (0x55 - index) & 0xff]);
}
async function setPolling(hz) {
  requireWritable();
  const code = POLL_CODES[hz];
  if (code === undefined) throw new Error('Unsupported polling rate');
  await writeBlock(0x0000, [code, (0x55 - code) & 0xff]);
}

// ---- load ----
async function load() {
  const ident = await ask(0x10);
  const ver = await ask(0x12);
  const bat = await ask(0x04).catch(() => null);
  const sys = await readRetry(0x0000, 6);
  const count = Math.min(Math.max(sys[2], 1), 8);
  const stages = [];
  for (let i = 0; i < count; i++) stages.push(decodeStage(await readRetry(0x000c + i * 4, 4)));
  return { ident, ver, bat, sys, stages };
}

// ---- UI ----
let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2400);
}

function showEmpty(title, text) {
  state = null;
  $('main').hidden = true;
  $('empty').hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
  $('battery').innerHTML = '';
  $('sub').textContent = 'Not connected';
}

const activeIndex = () => Math.min(state.sys[4], state.stages.length - 1);

function render() {
  const { ident, ver, bat, sys, stages } = state;
  const kind = (known(dev) || {}).kind;
  $('name').textContent = ident[5] === 2 ? 'VXE R1 SE+' : (dev.productName || 'ATK mouse');
  $('sub').textContent = (kind === 'wired' ? 'Wired' : '2.4 GHz') + '  \u00b7  Firmware ' + ver[5] + '.' + ver[6].toString(16);

  if (bat) {
    const pct = Math.min(bat[5], 100);
    const charging = bat[4] >= 2 && bat[6] !== 0;
    const fill = charging ? 'var(--good)' : pct <= 15 ? 'var(--bad)' : 'currentColor';
    $('battery').innerHTML =
      '<svg width="26" height="14" viewBox="0 0 26 14">' +
      '<rect x="0.5" y="0.5" width="22" height="13" rx="3" fill="none" stroke="currentColor" opacity=".6"/>' +
      '<rect x="2.5" y="2.5" width="' + Math.max(1, 18 * pct / 100) + '" height="9" rx="1.5" fill="' + fill + '"/>' +
      '<rect x="23.5" y="4" width="2" height="6" rx="1" fill="currentColor" opacity=".6"/></svg>' +
      '<span>' + pct + '%</span>' + (charging ? '<span class="chg">Charging</span>' : '');
  } else {
    $('battery').innerHTML = '';
  }

  const active = activeIndex();
  const box = $('stages');
  box.innerHTML = '';
  stages.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'stage' + (i === active ? ' active' : '');
    b.innerHTML = '<span class="idx">' + (i + 1) + '</span><span class="val">' + (s ? s.x : '?') +
                  '</span><span class="unit">DPI</span>';
    b.onclick = () => { if (i !== active) act(() => setActiveStage(i)); };
    box.append(b);
  });
  const cur = stages[active] ? stages[active].x : 800;
  $('editLabel').textContent = 'Stage ' + (active + 1);
  $('dpiRange').value = cur;
  $('dpiNum').value = cur;

  const rate = pairOk(sys[0], sys[1]) ? POLL[sys[0]] : undefined;
  const poll = $('poll');
  poll.innerHTML = '';
  [125, 250, 500, 1000].forEach(hz => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (hz === rate ? ' active' : '');
    b.textContent = String(hz);
    b.onclick = () => { if (hz !== rate) act(() => setPolling(hz)); };
    poll.append(b);
  });
}

async function refresh() {
  state = await load();
  $('empty').hidden = true;
  $('main').hidden = false;
  render();
}

async function act(fn) {
  if (busy || !dev) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
    await refresh();
    toast('Saved');
  } catch (e) {
    toast(e.message || 'Something went wrong', true);
    try { await refresh(); } catch {}
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    if (document.hidden) closeDev();
  }
}

function friendly(e) {
  const m = (e && e.message) || '';
  if (/open/i.test(m)) return 'Another app is using the mouse. Close ATK HUB and try again.';
  if (/timeout|no reply/i.test(m)) return 'The mouse is not answering. Move it to wake it up.';
  return m || 'Unknown error';
}

async function closeDev() {
  if (busy || !dev || !dev.opened) return;
  try { await dev.close(); } catch {}
}

async function connect() {
  if (connecting || busy) return;
  connecting = true;
  try {
    const list = (await navigator.hid.getDevices()).filter(d => isConfig(d) && known(d));
    const pick = list.find(d => d.productId === 0xf58f) || list[0];
    if (!pick) {
      dev = null;
      showEmpty('No mouse found', 'Plug in the cable or the 2.4G dongle.');
      return;
    }
    dev = pick;
    if (!dev.opened) await dev.open();
    await refresh();
  } catch (e) {
    dev = null;
    showEmpty('Cannot reach the mouse', friendly(e));
  } finally {
    connecting = false;
  }
}

// ---- editor inputs ----
const commitDpi = raw => {
  if (!state) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) { render(); return; }
  const v = Math.min(10000, Math.max(200, Math.round(n / 50) * 50));
  const idx = activeIndex();
  if (state.stages[idx] && state.stages[idx].x === v) { render(); return; }
  act(() => setStageDpi(idx, v));
};
$('dpiRange').addEventListener('input', e => { $('dpiNum').value = e.target.value; });
$('dpiRange').addEventListener('change', e => commitDpi(e.target.value));
$('dpiNum').addEventListener('change', e => commitDpi(e.target.value));

// ---- lifecycle: only hold the mouse while the popup is open ----
const onShow = () => {
  connect();
  if (!timer) timer = setInterval(() => { if (!dev) connect(); }, 2000);
};
const onHide = () => {
  clearInterval(timer);
  timer = null;
  closeDev();
};
window.addEventListener('focus', onShow);
window.addEventListener('blur', onHide);
document.addEventListener('visibilitychange', () => (document.hidden ? onHide() : onShow()));
navigator.hid.addEventListener('disconnect', e => {
  if (e.device === dev) { dev = null; showEmpty('Mouse disconnected', 'Plug it back in or switch to the dongle.'); }
});
navigator.hid.addEventListener('connect', () => { if (!document.hidden) setTimeout(connect, 500); });