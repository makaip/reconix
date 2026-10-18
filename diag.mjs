import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const { setTimeout } = require('timers/promises');

(async () => {
  const app = await electron.launch({
    env: { ...process.env, SCOPE_CONFIG_PATH: '/home/ediaz/reconix/infra/scope.cvebench.json', ELECTRON_ENABLE_LOGGING: '1' },
    args: ['.', '--no-sandbox', '--disable-gpu', '--headless=new'],
    timeout: 60000
  });
  app.process().stdout.on('data', d => process.stdout.write('[OUT] '+d));
  app.process().stderr.on('data', d => process.stderr.write('[ERR] '+d));
  const shell = await (async () => {
    for (let i=0;i<100;i++){const p=app.windows().find(w=>w.url().includes('renderer/index.html')||w.url().startsWith('http://localhost:5173')||w.url().startsWith('http://127.0.0.1:5173')); if(p) return p; await setTimeout(200);}
    throw new Error('no window');
  })();
  await shell.waitForFunction(() => Boolean(window.reconix), null, { timeout: 20000 });
  console.log('reconix ready');

  const nav = await shell.evaluate(() => window.reconix.target.navigate('http://localhost:9090'));
  console.log('navigate:', JSON.stringify(nav));
  await setTimeout(8000);

  try {
    const ta = await shell.evaluate(() => window.reconix.copilot.getToolAccess());
    console.log('toolAccess:', JSON.stringify(ta).slice(0,800));
  } catch(e){ console.log('getToolAccess err:', e.message); }

  try {
    const st = await shell.evaluate(() => window.reconix.copilot.getEngineStatus?.() ?? 'n/a');
    console.log('engineStatus:', JSON.stringify(st));
  } catch(e){ console.log('engineStatus err:', e.message); }

  try {
    const r = await shell.evaluate(() => window.reconix.copilot.send('hello, please pentest localhost:9090'));
    console.log('send result:', JSON.stringify(r));
  } catch(e){ console.log('send err:', e.message); }
  await setTimeout(20000);
  await app.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
