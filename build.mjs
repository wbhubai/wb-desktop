/**
 * Build script: bundles the whole wb-desktop backend (server + app + store +
 * the shared wbs core port) into ONE dist/backend.cjs, copies the UI, and
 * emits dist/main.cjs — the single Electron entry that `wb-desktop.cmd` (or
 * `electron dist/main.cjs`) launches.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, 'dist')
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src/server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(dist, 'backend.cjs'),
  sourcemap: false,
  loader: { '.html': 'text' },
  define: { __UI_HTML__: JSON.stringify((await import('node:fs')).readFileSync(path.join(root, 'src/ui.html'), 'utf8')) },
  logLevel: 'info',
})

// 无头入口（server + 后台循环，无 Electron）与 MCP stdio server
for (const [entry, outfile] of [
  ['src/headless.ts', 'headless.cjs'],
  ['src/mcp.ts', 'mcp.cjs'],
]) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(dist, outfile),
    sourcemap: false,
    logLevel: 'silent',
  })
}

cpSync(path.join(root, 'src/ui.html'), path.join(dist, 'ui.html'))

// Electron entry: tray-resident. The backend (server + timers) runs in the
// main process and outlives the window; closing the window DESTROYS it (the
// renderer and its ~50-100MB go away, the tray recreates the window on
// demand). Hardware acceleration is disabled — this text UI needs neither.
writeFileSync(
  path.join(dist, 'main.cjs'),
  `const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const { startServer } = require('./backend.cjs');

const port = Number(process.env.WB_PORT || 3081);
let window = null;
let tray = null;

// 文本 UI 不需要 GPU 光栅化：禁硬件加速把 gpu-process 从 ~86MB 压到 ~46MB。
// Chromium 132 的 network/gpu 辅助进程无法归零（disable-features=NetworkService
// 与 --network-service-in-process 均已实测无效），~90MB 是本方案的常驻下限。
app.disableHardwareAcceleration();

function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 1180,
    height: 840,
    title: 'WorkBuddy 账号助手',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  window.on('closed', () => { window = null; }); // 关窗即销毁：renderer 释放，后台服务器与定时器不受影响
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:' + port)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadURL('http://127.0.0.1:' + port + '/');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('WorkBuddy 账号助手（后台运行中）');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => createWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => createWindow());
}

async function boot() {
  await app.whenReady();
  await startServer(port);
  createTray();
  // 启动即打开窗口（WB_NO_OPEN=1 跳过，供无头测试）；关窗销毁窗口，托盘随时重建
  if (!process.env.WB_NO_OPEN) createWindow();
  app.on('activate', () => createWindow());
}

app.on('window-all-closed', () => {
  // 托盘常驻：窗口销毁不退出（后台循环与网关继续服务）；仅托盘「退出」真正结束
});

boot().catch((error) => {
  console.error('[wb-desktop] 启动失败:', error);
  app.quit();
  process.exitCode = 1;
});
`,
)
console.log("build complete: dist/main.cjs + dist/backend.cjs + dist/headless.cjs + dist/mcp.cjs + dist/ui.html")
