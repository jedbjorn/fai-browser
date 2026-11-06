#!/usr/bin/env node
// Linux only. All capture is on a new virtual KWin/XWayland display, behind a mandatory systemd memory cap.
// Stock signed Firefox is controlled only in its disposable profile, through the repo's Marionette smoke helper.
import assert from 'node:assert/strict';
import { appendFileSync, openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import net from 'node:net';
import { defaultDeps, launch } from '../src/launcher/launch.js';
import { launcherPaths } from '../src/launcher/dirs.js';
import { homePaths } from '../src/home.js';
import { FaiBrowserClient } from '../src/client.js';
import { Marionette } from './marionette.mjs';
import { startFixtures } from './demo/serve.mjs';
import { DemoFirefoxUI } from './demo/firefox-ui.mjs';
import { runDemoSession, captureDemoExtras } from './demo-session.mjs';
import { buildFirefox } from './build-firefox.mjs';
const root = resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const { values } = parseArgs({ options: { xpi: { type: 'string' }, firefox: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'dev-addon': { type: 'boolean' }, worker: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' } } });

async function run(command, args, options = {}) {
  if (command === 'ffmpeg') await readiness();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'],
    timeout: command === process.execPath ? 1_200_000 : 120_000, ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', x => { stdout += x; });
  child.stderr?.on('data', x => { stderr = (stderr + x).slice(-3000); });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw new Error(`${command} failed (${code}); ${command === 'systemd-run' || command === process.execPath
    ? stderr.trim().replaceAll(root, '[worktree]') : 'capture stopped; raw diagnostics are not printed'}`);
  return stdout;
}
async function readiness() {
  for (;;) {
    const free = execFileSync('free', ['-m'], { encoding: 'utf8' });
    process.stdout.write(free);
    const available = Number(free.split('\n').find(x => x.startsWith('Mem:'))?.trim().split(/\s+/).at(-1));
    let tests = true;
    try { execFileSync('pgrep', ['-f', '[n]ode --test'], { stdio: 'ignore' }); }
    catch (e) { if (e.status === 1) tests = false; else throw e; }
    if (available >= 4000 && !tests) return;
    console.log('Waiting 60 seconds: capture requires 4000 MB available and no node --test process.');
    await sleep(60_000);
  }
}
async function assertScope() {
  const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(x => x.startsWith('0::'))?.slice(3);
  assert.ok(cgroup && cgroup !== '/', 'A systemd memory scope is required');
  const cap = Number((await readFile(join('/sys/fs/cgroup', cgroup, 'memory.max'), 'utf8')).trim());
  assert.ok(Number.isFinite(cap) && cap <= 3000 * 1024 * 1024, 'MemoryMax must be at most 3000M');
}
async function port() {
  const s = net.createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done));
  const p = s.address().port; await new Promise(done => s.close(done)); return p;
}
async function until(probe, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await sleep(250); }
  throw new Error('Timed out starting the isolated capture environment');
}
function shQuote(text) { return `'${String(text).replaceAll("'", "'\\''")}'`; }

async function worker() {
  await assertScope();
  await readiness();
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const scratch = await mkdtemp(join(root, 'artifacts/demo-runtime-'));
  const output = await mkdtemp(join(root, 'artifacts/demo-capture-'));
  await writeFile(join(output, 'INCOMPLETE'), 'Unreviewed capture. Never publish until the manifest and every image/frame are reviewed.\n');
  const home = join(scratch, 'home');
  const runtime = join(scratch, 'runtime');
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(runtime, { mode: 0o700 });
  // Explicit allowlist: no desktop session, agent keys or owner configuration is inherited by any capture process.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: home, USER: 'demo', LOGNAME: 'demo',
    XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), TMPDIR: scratch, FAI_HOME: join(scratch, 'fai'),
    FAI_DAEMON_PORT: String(await port()), FAI_DEMO_ISOLATED: '1', FAI_MCP_MAX_CALL_MS: '90000',
    MOZ_ENABLE_WAYLAND: '0', MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',
    LIBGL_ALWAYS_SOFTWARE: '1', KWIN_COMPOSE: 'Q', QT_QPA_PLATFORM: 'offscreen',
    GVFS_DISABLE_FUSE: '1', GIO_USE_VFS: 'local', PS1: '$ ' };
  const children = [];
  let m, daemon, fixtures, recorder;
  const spawnOwned = (command, args, options = {}) => {
    const child = spawn(command, args, { env, cwd: scratch, stdio: 'ignore', detached: true, ...options });
    // Retain failures without emitting process arguments or environment.
    child.on('error', error => { child.launchError = error; }); children.push(child); return child;
  };
  const stopOwned = async child => {
    if (!child || child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return; cleaning = true;
    await stopOwned(recorder);
    try { await m?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {}
    m?.close();
    try { daemon ??= await FaiBrowserClient.connect({ env, autoStart: false, clientName: 'demo-cleanup' }); await daemon.shutdown(); } catch {}
    for (const child of children.toReversed()) await stopOwned(child);
    await fixtures?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().finally(() => process.exit(1)));
  try {
    const displayFile = join(scratch, 'display.json');
    const sessionJs = join(scratch, 'display-session.mjs');
    await writeFile(sessionJs, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(displayFile)},JSON.stringify(Object.fromEntries(['DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))));setInterval(()=>{},1000);`);
    const sessionSh = join(scratch, 'display-session.sh');
    await writeFile(sessionSh, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(sessionJs)}\n`, { mode: 0o700 });
    // --virtual is mandatory; there is deliberately no fallback to the inherited display.
    const compositorLog = openSync(join(output, 'compositor.log'), 'w', 0o600);
    spawnOwned('dbus-run-session', ['--', 'kwin_wayland', '--virtual', '--width', '1920', '--height', '1080',
      '--no-lockscreen', '--no-global-shortcuts', '--no-kactivities', '--socket', 'fai-demo', '--exit-with-session', sessionSh],
    { stdio: ['ignore', compositorLog, compositorLog] });
    closeSync(compositorLog);
    const display = await until(async () => { try { return JSON.parse(await readFile(displayFile, 'utf8')); } catch { return null; } });
    assert.equal(display.WAYLAND_DISPLAY, 'fai-demo');
    Object.assign(env, display);
    // An owned rootful XWayland framebuffer is capturable, unlike a compositor's rootless X root window.
    await readiness();
    const xlog = openSync(join(output, 'xwayland.log'), 'w', 0o600);
    const xserver = spawnOwned('Xwayland', ['-geometry', '1920x1080', '-shm', '-nolisten', 'tcp', '-ac', '-displayfd', '3'],
      { stdio: ['ignore', xlog, xlog, 'pipe'] });
    closeSync(xlog);
    let displayNumber = ''; xserver.stdio[3].on('data', data => { displayNumber += data; });
    await until(() => /^\d+\n$/.test(displayNumber), 15000);
    env.DISPLAY = `:${displayNumber.trim()}`;
    console.log('Private compositor started; checking its owned XWayland framebuffer.');
    const geometry = await run('xdpyinfo', [], { env, timeout: 15_000 });
    assert.match(geometry, /dimensions:\s+1920x1080/);
    fixtures = await startFixtures();
    const fakeContext = {};
    runInNewContext(await readFile(join(root, 'fixtures/secrets/fakes.js'), 'utf8'), fakeContext);
    // Exclusively create a throwaway settings file with an existing FAKE fixture value. Never inspect any settings.
    const settings = homePaths({ env }); await mkdir(settings.home, { recursive: true, mode: 0o700 });
    await writeFile(settings.envFile, `FAI_BRIDGE_SECRET="${fakeContext.FAKE_SECRETS.genericKey}"\n`, { flag: 'wx', mode: 0o600 });
    const paths = launcherPaths({ env });
    const marionettePort = await port();
    const sourceXpi = values.xpi && resolve(values.xpi);
    assert.ok(sourceXpi, 'Pass --xpi with the read-only signed Firefox add-on');
    const xpi = join(scratch, 'signed-addon.xpi'); await copyFile(sourceXpi, xpi);
    let welcomeFragment;
    const deps = defaultDeps({ env, home, interactive: false, out: () => {},
      fetch: () => { throw new Error('Network downloads are disabled in the demo'); },
      async spawnBrowser(command, { env: launchEnv }) {
        await readiness();
        const prefs = {
          'marionette.port': marionettePort, 'layout.css.devPixelsPerPx': '1.0',
          'browser.startup.homepage': 'about:blank', 'browser.newtabpage.enabled': false,
          'extensions.update.enabled': false, 'app.update.disabledForTesting': true,
          'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false,
          'network.trr.mode': 5, 'network.dns.disablePrefetch': true, 'network.prefetch-next': false,
          'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9,
          'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
          'network.proxy.no_proxies_on': 'localhost, 127.0.0.1',
        };
        await appendFile(join(paths.profile, 'user.js'), '\n'+Object.entries(prefs).map(([k,v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
        const args = command.slice(1);
        const at = args.findIndex(a => a.startsWith('file:'));
        if (at !== -1) {
          const welcome = new URL(args[at]); const fragment = new URLSearchParams(welcome.hash.slice(1));
          fragment.delete('profilePath'); welcomeFragment = fragment.toString(); args[at] = 'about:blank';
        }
        const child = spawnOwned(command[0], [...args, '--marionette'], { env: { ...launchEnv, ...env } });
        return { pid: child.pid };
      },
    });
    const launched = await launch({ xpi, firefox: values.firefox, desktop: false, wait: false }, deps);
    assert.equal(launched.status, 'started');
    m = await Marionette.connect(marionettePort, { timeoutMs: 60_000 }); await m.newSession();
    daemon = await FaiBrowserClient.connect({ env, autoStart: false, clientName: 'demo-capture' });
    await until(async () => (await daemon.status()).extension?.connected, 45_000);
    const ui = new DemoFirefoxUI(m, { output, fixtures }); const launcherAddon = await ui.init();
    // The actual launcher page, served on loopback with its generated checks and only the private path omitted.
    fixtures.setWelcome(await readFile(paths.welcome), await readFile(join(paths.data, 'fai-browser.png')));
    await m.navigate(`${fixtures.shop}/welcome.html#${welcomeFragment}`);
    await m.send('WebDriver:SetWindowRect', { x: 1100, y: 0, width: 820, height: 1010 });
    await ui.capture('firefox-launcher', { selector: 'main' });
    let addon = launcherAddon;
    if (values['dev-addon']) {
      const build = join(scratch, 'addon');
      await buildFirefox({ root, out: build });
      await m.installAddon(build, { temporary: true });
      await until(async () => (await daemon.status()).extension?.connected);
      addon = await ui.init({ development: true });
    }
    const transcript = join(scratch, 'transcript.txt'); await writeFile(transcript, 'FAI Browser\nScripted MCP session · local fixtures · automated approvals\n');
    spawnOwned('alacritty', ['--title', 'FAI scripted MCP demo', '--working-directory', scratch,
      '--option', 'general.ipc_socket=false',
      '--option', 'window.position.x=0', '--option', 'window.position.y=0', '--option', 'window.dimensions.columns=85',
      '--option', 'window.dimensions.lines=32', '--option', 'font.size=16', '--option', 'window.decorations="None"',
      '--option', 'colors.primary.background="#0c2521"', '--option', 'colors.primary.foreground="#e8f4ed"',
      '-e', 'tail', '-n', '+1', '-f', transcript], { env: { ...env, WAYLAND_DISPLAY: undefined, WINIT_UNIX_BACKEND: 'x11' } });
    await sleep(1200);
    // Catch unsupported rootless XWayland capture before producing a bogus black video.
    const grab = ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1920x1080', '-framerate', '30', '-i', env.DISPLAY];
    const probe = join(scratch, 'probe.png'); await run('ffmpeg', [...grab, '-frames:v', '1', '-threads', '1', probe], { env });
    const mean = Number(await run('python3', ['-c', 'from PIL import Image,ImageStat;import sys;print(sum(ImageStat.Stat(Image.open(sys.argv[1]).convert("RGB")).mean)/3)', probe], { env }));
    assert.ok(mean > 4, 'Virtual XWayland capture is black. Stop; xorg-server-xvfb would provide a capturable nested X display.');
    await copyFile(probe, join(output, 'capture-layout.png'));
    await readiness();
    if (!values['dry-run']) recorder = spawnOwned('ffmpeg', [...grab, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-threads', '2', '-pix_fmt', 'yuv420p', '-t', '90', '-movflags', '+faststart', join(output, 'raw.mp4')]);
    ui.started = Date.now();
    let imageCount = 0;
    const images = [];
    const report = await runDemoSession({ env, ui, fixtures,
      write: text => {
        assert.doesNotMatch(text, /\/home\/|\/Users\/|file:\/\//, 'Private path in MCP output; abort recording');
        // Synchronous append preserves the typing effect's order and backpressure.
        appendFileSync(transcript, text);
      },
      onImage: async item => {
        assert.ok(['image/png','image/jpeg'].includes(item.mimeType));
        const name = `agent-image-${++imageCount}.${item.mimeType === 'image/png' ? 'png' : 'jpg'}`;
        await writeFile(join(output, name), Buffer.from(item.data, 'base64'));
        images.push({ name, seconds: (Date.now()-ui.started)/1000 });
      },
      onScene: async () => {},
    });
    if (recorder) {
      if (recorder.exitCode === null) { recorder.kill('SIGINT'); await new Promise(done => recorder.once('exit', done)); }
      assert.ok(!recorder.launchError, 'ffmpeg failed to start');
    }
    await copyFile(transcript, join(output, 'session-transcript.txt'));
    assert.ok(imageCount > 0, 'No actual redacted MCP image was returned; do not fake it');
    await captureDemoExtras({ env, ui, fixtures });
    await writeFile(join(output, 'session.json'), JSON.stringify({ ...report, ui: ui.events, images, addon, launcherAddon,
      capture: 'isolated KWin virtual display / XWayland; signed Firefox; Marionette UI; real MCP SDK',
      note: 'Unreviewed. Screenshots are actual UI; dark extension UI is not supported. Welcome uses actual checks with profilePath omitted.' }, null, 2));
    await cleanup();
    if (!values['dry-run']) await run(process.execPath, [join(root, 'scripts/demo/export.mjs'), output], { env, cwd: root });
    console.log(`Capture awaits visual review: ${relative(root, output)}`);
    // Deliberately keep INCOMPLETE until a human/agent reviews all exported frames and images.

  } catch (error) {
    await copyFile(join(scratch, 'transcript.txt'), join(output, 'session-transcript.txt')).catch(() => {});
    console.error(`Capture failure before cleanup: ${error.stack.replaceAll(root, '[worktree]').replace(/\/home\/\S+|\/Users\/\S+/g, '[private path]')}`);
    throw error;
  } finally { await cleanup(); }
}
if (values.help) {
  console.log('node scripts/record-demo.mjs --xpi /path/to/signed.xpi [--firefox /path/to/firefox] [--dry-run]\n--check checks memory, tools and the mandatory systemd scope without launching a browser.\nOutputs stay in artifacts/demo-capture-* until reviewed. No real desktop fallback.');
} else if (!values.worker) {
  try {
    await readiness();
    for (const tool of ['kwin_wayland','Xwayland','dbus-run-session','xdpyinfo','ffmpeg','ffprobe','alacritty','python3'])
      execFileSync('which', [tool], { stdio: 'ignore' });
    if (values.check) {
      await run('systemd-run', ['--user','--scope','--quiet','-p','MemoryMax=3000M','-p','MemorySwapMax=256M','timeout','5','true']);
      console.log('Capture preflight passed. No browser was launched.');
    } else {
      assert.ok(values.xpi, '--xpi is required; the demo never downloads a package');
      const child = spawn('systemd-run', ['--user','--scope','--quiet','-p','MemoryMax=3000M','-p','MemorySwapMax=256M',
        'timeout','1800',process.execPath,import.meta.filename,...process.argv.slice(2),'--worker'], { stdio: 'inherit' });
      process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  try { await worker(); } catch (error) { console.error(`Capture stopped: ${error.message.replace(/\/home\/\S+|\/Users\/\S+/g, '[private path]')}`); process.exitCode = 1; }
}
