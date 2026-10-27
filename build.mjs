/**
 * Build script: bundles the whole wb-desktop backend (server + app + store +
 * the shared wbs core port) into ONE dist/backend.cjs, copies the UI, and
 * emits dist/main.cjs — the single Electron entry that `wb-desktop.cmd` (or
 * `electron dist/main.cjs`) launches.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, 'dist')
mkdirSync(dist, { recursive: true })

const APP_VERSION = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version

// 打包程序名（productName/exe 名）带版本号：多版本共存时可区分。
// 仅在变化时写回 package.json——electron-builder 从 package.json 的 build 字段读配置，
// 与版本号一起随 bump 提交一次即可。
const PKG_NAME_WITH_VERSION = `WorkBuddy Account Hub v${APP_VERSION}`
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  let changed = false
  if (pkg.build?.productName !== PKG_NAME_WITH_VERSION) {
    pkg.build.productName = PKG_NAME_WITH_VERSION
    changed = true
    console.log(`productName -> ${PKG_NAME_WITH_VERSION}`)
  }
  // portable 解压目录用 electron-builder 默认（KSUID，27 位纯字母数字）。
  // 不要自定义 unpackDirName：解压路径是 %TEMP%\<unpackDirName>\，自定义值
  // 含点号且偏长，叠加深层 payload 路径后实测会让 NSIS 报 "Error writing
  // temporary file"（写 %TEMP% 失败）。默认值按版本天然隔离，无需手动隔离。
  // 产物文件名的版本号用下划线：避免文件名含额外点号（与解压路径无关，仅
  // 命名风格统一）。
  const artifactName = `wb-desktop-${APP_VERSION.replace(/\./g, '_')}-portable.exe`
  if (pkg.build?.portable?.artifactName !== artifactName) {
    pkg.build.portable = pkg.build.portable ?? {}
    pkg.build.portable.artifactName = artifactName
    changed = true
    console.log(`portable.artifactName -> ${artifactName}`)
  }
  if (changed) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  }
}

await build({
  entryPoints: [path.join(root, 'src/server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(dist, 'backend.cjs'),
  sourcemap: false,
  loader: { '.html': 'text' },
  define: { __UI_HTML__: JSON.stringify((await import('node:fs')).readFileSync(path.join(root, 'src/ui.html'), 'utf8')), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  logLevel: 'info',
})

// 无头入口（server + 后台循环，无 Electron）与 MCP stdio server
// 与 backend.cjs 同款 UI 注入：headless 的 GET / 也需要内嵌 ui.html
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
    loader: { '.html': 'text' },
    define: { __UI_HTML__: JSON.stringify((await import('node:fs')).readFileSync(path.join(root, 'src/ui.html'), 'utf8')), __APP_VERSION__: JSON.stringify(APP_VERSION) },
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

const APP_VERSION = '${APP_VERSION}';
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
    title: 'WorkBuddy 账号助手 v' + APP_VERSION,
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
  tray.setToolTip('WorkBuddy 账号助手 v' + APP_VERSION + '（后台运行中）');
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
