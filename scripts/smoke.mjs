// Headless smoke test: loads the page via Chrome DevTools Protocol over a raw
// WebSocket, collects console messages + page errors, and screenshots the
// canvas. Catches runtime shader-compile / WebGL failures the build can't see.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://localhost:4321/';
const PORT = 9222;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu=false',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1280,800',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + process.env.TEMP + '\\bh-smoke',
  URL,
]);

const getJSON = (path) =>
  new Promise((res, rej) => {
    http.get({ host: 'localhost', port: PORT, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(2500);
  let target;
  for (let i = 0; i < 10; i++) {
    const list = await getJSON('/json');
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(500);
  }
  if (!target) throw new Error('no page target');

  const { default: WS } = await import('ws').catch(() => ({ default: null }));
  // Minimal CDP client without external deps: use global WebSocket (Node 22+).
  const ws = new (globalThis.WebSocket || WS)(target.webSocketDebuggerUrl);
  const logs = [];
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push('[console] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const e = msg.params.exceptionDetails;
      logs.push('[exception] ' + (e.exception?.description || e.text));
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2000);

  // Optional: click a focus chip / button by its text (argv[3]) and let the
  // camera fly there before screenshotting.
  const clickText = process.argv[3];
  if (clickText) {
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.chip,.btn,button')].find(b=>b.textContent.trim()==='${clickText}')?.click()`,
    });
    await sleep(3500);
  }
  await sleep(2000); // let it render several frames

  const fps = await send('Runtime.evaluate', {
    expression: "document.getElementById('fps')?.textContent || 'n/a'",
    returnByValue: true,
  });
  const overlayHidden = await send('Runtime.evaluate', {
    expression: "document.getElementById('overlay')?.classList.contains('hidden')",
    returnByValue: true,
  });

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    writeFileSync('scripts/render.png', Buffer.from(shot.data, 'base64'));
  }

  console.log('FPS readout:', fps.result.value);
  console.log('Overlay hidden (rendered):', overlayHidden.result.value);
  console.log('--- logs ---');
  console.log(logs.length ? logs.join('\n') : '(no console errors/exceptions)');

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e);
  chrome.kill();
  process.exit(1);
});
