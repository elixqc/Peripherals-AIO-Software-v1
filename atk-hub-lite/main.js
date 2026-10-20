const { app, BrowserWindow, Tray, Menu, nativeImage, screen } = require('electron');

if (!app.requestSingleInstanceLock()) app.quit();

let tray = null;
let win = null;
let lastHide = 0;
const W = 360;
const H = 390;

// Tray icon drawn in code (a small mouse). Swap in your own with nativeImage.createFromPath('icon.png').
function makeIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const r = 8, cx = 16, top = 3, bottom = 29;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const cy = Math.min(Math.max(py, top + r), bottom - r);
      const dist = Math.hypot(px - cx, py - cy);
      let cov = Math.min(1, Math.max(0, r + 0.5 - dist));
      if ((Math.abs(px - cx) < 1 && py < 15) || Math.abs(py - 15) < 1) cov = 0;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(255 * cov);      // B
      buf[i + 1] = Math.round(194 * cov);  // G
      buf[i + 2] = Math.round(76 * cov);   // R
      buf[i + 3] = Math.round(255 * cov);  // A
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function createWindow() {
  win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  });

  const ses = win.webContents.session;
  ses.setDevicePermissionHandler(d => d.deviceType === 'hid');

  win.loadFile('index.html');

  win.on('blur', () => {
    if (win.isVisible()) {
      lastHide = Date.now();
      win.hide();
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.hide();
  });
}

function place() {
  const tb = tray.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  const [w, h] = win.getSize();
  let x = Math.round(tb.x + tb.width / 2 - w / 2);
  if (!tb.width) x = wa.x + wa.width - w - 12;
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8);
  win.setPosition(x, wa.y + wa.height - h - 12, false);
}

function toggle() {
  if (win.isVisible()) { win.hide(); return; }
  if (Date.now() - lastHide < 250) return; // the click that just blurred it
  place();
  win.show();
  win.focus();
}

app.on('second-instance', () => toggle());
app.on('window-all-closed', () => {}); // stay alive in the tray

app.whenReady().then(() => {
  createWindow();
  tray = new Tray(makeIcon());
  tray.setToolTip('ATK HUB Lite');
  tray.on('click', toggle);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => { place(); win.show(); win.focus(); } },
    ...(app.isPackaged ? [{
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
    }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
});