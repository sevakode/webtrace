import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import injection from '../src/recorder-source.json';
import type { TraceEvent } from '../src/session';

const documentHtml = '<!doctype html><title>Recorder lifecycle fixture</title><button id="during">During</button><button id="after">After</button>';

async function until(check: () => boolean, description: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < deadline, 'Timed out waiting for ' + description);
    await delay(10);
  }
}

async function withRecorder(handler: RequestListener, run: (page: Page, events: TraceEvent[]) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(documentHtml);
    } else handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Browser | undefined;
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext();
    const events: TraceEvent[] = [];
    await context.exposeBinding('__collectLifecycle', (_source, raw: string) => events.push(JSON.parse(raw)));
    await context.addInitScript({ content: `window.ReactNativeWebView={postMessage:raw=>window.__collectLifecycle(raw)};${injection}` });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    assert.equal(await page.evaluate('typeof window.__webtrace.finish'), 'function', 'Regenerate recorder-source.json with the finish implementation before running this test');
    await run(page, events);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function assertQuietAfterFinish(page: Page, events: TraceEvent[]): Promise<void> {
  // Let earlier bridge messages settle, then exercise real page behavior after stop.
  await delay(60);
  const before = events.length;
  // A string avoids tsx's function-name helper leaking into the browser realm.
  await page.evaluate(`(() => {
    const state = window;
    state.postFinishClick = 0;
    document.getElementById('after').addEventListener('click', () => state.postFinishClick++);
    document.getElementById('after').click();
    setTimeout(function postFinishTimer() { state.postFinishTimer = true; }, 20);
    const interval = setInterval(function postFinishInterval() { state.postFinishInterval = true; clearInterval(interval); }, 30);
    void fetch('/after').then(response => response.text()).then(() => state.postFinishFetch = true);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/after');
    xhr.addEventListener('loadend', () => state.postFinishXhr = true);
    xhr.send();
    history.pushState({}, '', '#after-finish');
    const anchor = document.createElement('a');
    anchor.href = 'afterfinishapp://do-not-capture';
    document.body.appendChild(anchor);
  })()`);
  await page.waitForFunction('window.postFinishClick === 1 && window.postFinishTimer && window.postFinishInterval && window.postFinishFetch && window.postFinishXhr');
  await delay(350); // Includes the recorder's mutation scan delay, if it was left active.
  assert.deepEqual(events.slice(before), [], 'Clicks, timers, DOM changes, history and new requests after finish must not append events');
}

test('finish drains delayed headers and bodies before its matching ACK, includes XHR status and exact-limit bodies', async () => {
  const exactBody = 'x'.repeat(512 * 1024);
  await withRecorder((request, response) => {
    if (request.url === '/exact') {
      response.setHeader('content-type', 'text/plain');
      response.end(exactBody);
    } else if (request.url === '/slow-headers') {
      setTimeout(() => {
        response.setHeader('content-type', 'text/plain');
        response.end('slowheadersapp://captured');
      }, 200);
    } else if (request.url === '/slow-body') {
      response.setHeader('content-type', 'text/plain');
      response.flushHeaders();
      response.write('slowbodyapp://');
      setTimeout(() => response.end('captured'), 240);
    } else if (request.url === '/xhr') {
      setTimeout(() => {
        response.writeHead(202, { 'content-type': 'text/plain' });
        response.end('xhrfinishapp://captured');
      }, 175);
    } else response.end('ok');
  }, async (page, events) => {
    await page.evaluate("fetch('/exact').then(response => response.text())");
    await until(() => events.some(event => event.kind === 'artifact' && event.data.url.endsWith('/exact')), '512 KiB response body');
    const exact = events.find(event => event.kind === 'artifact' && event.data.url.endsWith('/exact'))!;
    assert.equal(exact.data.truncated, false, 'A response equal to the size limit is complete');
    assert.equal(exact.data.bytes, 512 * 1024);
    assert.equal(Buffer.from(exact.data.body, 'base64').toString('utf8'), exactBody);

    await page.evaluate(`(() => {
      const state = window;
      void fetch('/slow-headers').then(response => response.text()).then(body => state.slowHeaders = body);
      void fetch('/slow-body').then(response => response.text()).then(body => state.slowBody = body);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/xhr');
      xhr.send();
      void state.__webtrace.finish('finish:drain-test');
      document.getElementById('during').click();
      setTimeout(function duringFinishTick() { state.duringFinishTick = true; }, 25);
    })()`);
    await until(() => events.some(event => event.kind === 'snapshot-complete' && event.data.requestId === 'finish:drain-test'), 'matching finish ACK');
    const ackIndex = events.findIndex(event => event.kind === 'snapshot-complete' && event.data.requestId === 'finish:drain-test');
    for (const [path, expectedBody] of [['/slow-headers', 'slowheadersapp://captured'], ['/slow-body', 'slowbodyapp://captured']] as const) {
      const artifactIndex = events.findIndex(event => event.kind === 'artifact' && event.data.url.endsWith(path));
      assert(artifactIndex !== -1 && artifactIndex < ackIndex, path + ' must be exported before completion');
      const artifact = events[artifactIndex];
      assert.equal(artifact.data.source, 'fetch-response');
      assert.equal(artifact.data.truncated, false);
      assert.equal(Buffer.from(artifact.data.body, 'base64').toString('utf8'), expectedBody);
      const request = events.find(event => event.kind === 'request' && event.data.url.endsWith(path));
      assert.equal(artifact.data.requestId, request?.data.requestId);
    }
    const xhrArtifactIndex = events.findIndex(event => event.kind === 'artifact' && event.data.source === 'xhr-response' && event.data.url.endsWith('/xhr'));
    assert(xhrArtifactIndex !== -1 && xhrArtifactIndex < ackIndex, 'Pending XHR body must precede completion');
    assert.equal(events[xhrArtifactIndex].data.status, 202, 'XHR artifacts need their actual HTTP status');
    assert(events.some(event => event.kind === 'artifact' && event.data.source === 'dom-snapshot'), 'finish must take a final DOM snapshot');
    assert(!events.some(event => event.kind === 'action' && event.data.target === 'button#during'), 'ordinary events freeze when finish begins');
    assert(!events.some(event => event.kind === 'timer' && event.data.callback === 'duringFinishTick'), 'new timers during finish must not be recorded');
    assert(!events.some(event => event.kind === 'gap' && event.data.reason === 'finish-drain-timeout'), 'completed pending work must not be reported as timed out');
    await assertQuietAfterFinish(page, events);
  });
});

test('finish has a bounded drain for never-ending requests, records pending IDs and stays quiet after late completion', async () => {
  let heldResponse: ServerResponse | undefined;
  await withRecorder((request, response) => {
    if (request.url === '/never') heldResponse = response; // Deliberately do not send headers.
    else response.end('ok');
  }, async (page, events) => {
    await page.evaluate("void fetch('/never').then(response => response.text()).catch(() => {})");
    await until(() => Boolean(heldResponse) && events.some(event => event.kind === 'request' && event.data.url.endsWith('/never')), 'pending request registration');
    const pending = events.find(event => event.kind === 'request' && event.data.url.endsWith('/never'))!;
    const started = performance.now();
    await page.evaluate("void window.__webtrace.finish('finish:timeout-test')");
    await until(() => events.some(event => event.kind === 'snapshot-complete' && event.data.requestId === 'finish:timeout-test'), 'bounded finish ACK', 3200);
    assert(performance.now() - started < 3000, 'The two-second drain must stay bounded, allowing scheduler overhead');
    const ackIndex = events.findIndex(event => event.kind === 'snapshot-complete' && event.data.requestId === 'finish:timeout-test');
    const gapIndex = events.findIndex(event => event.kind === 'gap' && event.data.reason === 'finish-drain-timeout');
    assert(gapIndex !== -1 && gapIndex < ackIndex, 'A drain timeout must be reported before the ACK');
    assert(JSON.stringify(events[gapIndex].data).includes(pending.data.requestId), 'The gap must identify the uncompleted request');
    assert(!events.some(event => event.kind === 'artifact' && event.data.url.endsWith('/never')));
    await delay(60);
    const beforeLateResponse = events.length;
    heldResponse!.setHeader('content-type', 'text/plain');
    heldResponse!.end('latefinishapp://do-not-capture');
    await delay(150);
    assert.deepEqual(events.slice(beforeLateResponse), [], 'A late response after finish must not reopen recording');
    await assertQuietAfterFinish(page, events);
  });
});
