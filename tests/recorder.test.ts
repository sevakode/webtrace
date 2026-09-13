import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import injection from '../src/recorder-source.json';
import { ingest, makeArchive, newSession, normalizeUrl, summarize } from '../src/session';

const fixture = `<!doctype html><title>WebTrace fixture</title>
<script src="/app.js"></script><link rel="stylesheet" href="/style.css">
<input id="secret" value="DO_NOT_CAPTURE_FORM"><textarea>DO_NOT_CAPTURE_FORM</textarea>
<button id="run">Run</button><a id="deep" href="demoapp://product/42?source=fixture">Deep</a>
<a href="https://example.test/open?redirect=demoapp%3A%2F%2Foffer%2F7">Nested</a>
<script>
window.testValue = 0;
const id = setInterval(function poll(){ window.testValue++; if(window.testValue === 2) clearInterval(id); }, 20);
document.getElementById('run').onclick = async function checkout(){
 const data = await fetch('/api').then(r=>r.json()); window.answer = data.ok;
 const xhr = new XMLHttpRequest(); xhr.open('GET','/xhr'); xhr.send();
 history.pushState({},'', '/checkout#ready');
 const a = document.createElement('a'); a.href='lateapp://opened/5'; document.body.appendChild(a);
};
</script>`;

test('URL validation and untrusted bridge / archive paths', () => {
  assert.equal(normalizeUrl(' example.com/a '), 'https://example.com/a');
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.throws(() => normalizeUrl('https://user:pass@example.com'));
  const session = newSession('https://example.com');
  assert.equal(ingest(session, '{bad'), false);
  assert.equal(ingest(session, JSON.stringify({protocol:'webtrace/1', id:'x', at:1, page:'x', kind:'artifact', data:{body:2}})), false);
  ingest(session, JSON.stringify({protocol:'webtrace/1', id:'x', at:1, page:'x', kind:'artifact', data:{url:'../../outside',body:'AAEC/f7/',encoding:'base64',mime:'application/octet-stream'}}));
  const zip = unzipSync(makeArchive(session));
  assert.deepEqual([...zip['files/000001.bin']], [0,1,2,253,254,255]);
  assert(!Object.keys(zip).some(name => name.includes('..')));
});

test('browser records actions, late deeplinks, network, timers and exports actual files', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/app.js') { res.setHeader('content-type','text/javascript'); res.end('window.externalLink="externalapp://item/9";'); }
    else if(req.url === '/style.css') { res.setHeader('content-type','text/css'); res.end('body { color: #123456; }'); }
    else if(req.url === '/api') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true,deep:'responseapp://open/1'})); }
    else if(req.url === '/xhr') { res.setHeader('content-type','text/plain'); res.end('xhrapp://open/2'); }
    else if(req.url === '/expired') { res.writeHead(410, {'content-type':'text/html'}); res.end('<h1>Link expired</h1><a href="recoverapp://retry/1">Retry</a>'); }
    else if(req.url === '/large') { res.setHeader('content-type','text/plain'); res.end('x'.repeat(800000)); }
    else { res.setHeader('content-type','text/html'); res.end(fixture); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const session = newSession(url);
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const context = await browser.newContext();
    await context.exposeBinding('__collect', (_source, raw) => ingest(session, raw));
    await context.addInitScript({content: `window.ReactNativeWebView={postMessage:raw=>window.__collect(raw)};${injection}`});
    const page = await context.newPage();
    await page.goto(url);
    await page.click('#run');
    await page.waitForFunction('window.answer === true && window.testValue === 2');
    await page.waitForTimeout(450);
    await page.evaluate('window.__webtrace.snapshot(true)');
    await page.waitForTimeout(100);
    const summary = summarize(session);
    assert(summary.actions >= 1);
    assert(summary.requests >= 2);
    assert(summary.timers >= 1);
    for(const prefix of ['demoapp:', 'lateapp:', 'responseapp:', 'xhrapp:', 'externalapp:']) assert(summary.links.some(l => l.url.startsWith(prefix)), prefix);
    assert(summary.links.some(l => l.url === 'demoapp://offer/7'));
    assert.equal(hits.filter(p => p === '/api').length, 1, 'API must not be replayed');
    assert.equal(hits.filter(p => p === '/xhr').length, 1);
    assert(hits.filter(p => p === '/app.js').length >= 2, 'static script is explicitly re-fetched');
    assert(session.events.some(e=>e.kind==='timer-clear'));
    assert(session.events.some(e=>e.kind==='navigation' && e.data.api==='pushState'));
    const zip = unzipSync(makeArchive(session));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']));
    const html = manifest.find((f:any)=>f.source==='dom-snapshot');
    assert(!strFromU8(zip[html.path]).includes('DO_NOT_CAPTURE_FORM'));
    assert(manifest.some((f:any)=>f.source==='fetch-response'));
    await page.evaluate("fetch('/large').then(r=>r.text())");
    await page.waitForTimeout(300);
    assert(session.events.some(e=>e.kind==='artifact' && e.data.url.endsWith('/large') && e.data.truncated));
    const expired = await page.goto(url+'/expired');
    assert.equal(expired?.status(),410);
    await page.evaluate('window.__webtrace.snapshot(false)');
    await page.waitForTimeout(100);
    assert(summarize(session).links.some(l=>l.url==='recoverapp://retry/1'));
    await page.evaluate('window.__webtrace.stop()');
    await page.waitForTimeout(100);
    const count = session.events.length;
    await page.evaluate("fetch('/api')");
    await page.waitForTimeout(100);
    assert.equal(session.events.length,count,'stop prevents further collection');
    session.endedAt = new Date().toISOString();
    await writeFile('../sample-session.zip', makeArchive(session));
  } finally { await browser.close(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('native fallback captures missing assets and never replays API', async () => {
  const { downloadMissingResources } = await import('../src/resources');
  const session = newSession('https://example.test');
  for (const [url,type] of [['https://cdn.test/app.js','script'],['https://example.test/api','fetch'],['file:///etc/passwd','script']]) {
    ingest(session, JSON.stringify({protocol:'webtrace/1',id:url,at:1,page:session.url,kind:'resource',data:{url,type}}));
  }
  const called: string[] = [];
  const fakeFetch = async (url: any, options: any) => {
    called.push(url); assert.equal(options.credentials,'omit');
    return new Response('const deep="nativeapp://offer/42";',{headers:{'content-type':'text/javascript'}});
  };
  await downloadMissingResources(session, fakeFetch as typeof fetch);
  assert.deepEqual(called,['https://cdn.test/app.js']);
  assert(summarize(session).links.some(link=>link.url==='nativeapp://offer/42'));
  const zip=unzipSync(makeArchive(session));
  const manifest=JSON.parse(strFromU8(zip['manifest.json']));
  assert.equal(manifest[0].source,'native-resource-refetch');
  assert(strFromU8(zip[manifest[0].path]).includes('nativeapp://offer/42'));
  await downloadMissingResources(session, fakeFetch as typeof fetch);
  assert.equal(called.length,1,'previously captured complete file should not be re-fetched');
});
