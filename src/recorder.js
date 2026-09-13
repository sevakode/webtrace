// Runs in the page world. Keep self-contained: it is serialized into a WebView.
export function installRecorder() {
  if (window.__webtrace) return;
  const originalFetch = window.fetch.bind(window);
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  const pageId = Math.random().toString(36).slice(2);
  let sequence = 0, enabled = true, totalBytes = 0, busy = 0, sent = 0, draining = false;
  let observer = null, finishPromise = null;
  const pendingNetwork = new Set(), readers = new Set();
  const drainKinds = new Set(['artifact','response','network-error','gap','link','resource','snapshot-error','recorder-stopped']);
  const MAX_FILE = 512 * 1024, MAX_TOTAL = 12 * 1024 * 1024;
  const resources = new Map(), links = new Set(), inline = new Set();
  const stack = () => String(new Error().stack || '').slice(0, 2500);
  function emit(kind, data = {}, control = false) {
    if (!control && (!enabled || sent >= 15000 || (draining && !drainKinds.has(kind)))) return;
    try {
      sent++;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        protocol: 'webtrace/1', id: pageId + ':' + (++sequence),
        at: Date.now(), elapsed: performance.now(), page: location.href, kind, data,
      }));
      if (sent === 14999) emit('gap', { reason: 'page-event-limit' });
    } catch (_) { /* Instrumentation must not throw into the application. */ }
  }
  function link(raw, source, attempted = false, depth = 0) {
    if (typeof raw !== 'string' || raw.length > 8192) return;
    let url;
    try { url = new URL(raw, location.href); } catch (_) { return; }
    if (/^(javascript|data|blob|about):$/.test(url.protocol)) return;
    const key = url.href + source + attempted;
    if (links.has(key) || links.size >= 3000) return;
    links.add(key);
    emit('link', { url: url.href, source, attempted,
      classification: /^https?:$/.test(url.protocol) ? 'web-link-unverified' : 'custom-scheme' });
    if (depth < 2) url.searchParams.forEach(value => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) link(value, 'nested-query', false, depth + 1);
    });
  }
  function scanText(text, source) {
    const matches = String(text).match(/[a-z][a-z0-9+.-]{1,30}:\/\/[^\s"'<>`\\]{1,2048}|intent:[^\s"'<>`]{1,4096}/gi) || [];
    matches.slice(0, 500).forEach(value => link(value, source));
  }
  function resource(raw, type) {
    try {
      const url = new URL(raw, location.href).href;
      if (!resources.has(url) && resources.size < 2000) {
        resources.set(url, type); emit('resource', { url, type });
      }
    } catch (_) {}
  }
  function selector(el) {
    if (!el || !el.tagName) return '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id.slice(0, 80) : '') +
      (el.getAttribute('role') ? '[role=' + el.getAttribute('role').slice(0, 40) + ']' : '');
  }
  function scan(root) {
    if (!root.querySelectorAll) return;
    const nodes = [root, ...root.querySelectorAll('a[href],script,link[href],img[src],source[src],iframe[src],meta[content],*[data-deeplink]')];
    nodes.slice(0, 3000).forEach(el => {
      if (!el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') link(el.getAttribute('href'), 'dom-anchor');
      if (el.hasAttribute('data-deeplink')) link(el.getAttribute('data-deeplink'), 'data-deeplink');
      if (tag === 'meta') scanText(el.getAttribute('content'), 'meta');
      if (['script', 'img', 'source', 'iframe'].includes(tag) && el.src) resource(el.src, tag);
      if (tag === 'link' && /stylesheet|preload|modulepreload|icon/.test(el.rel)) resource(el.href, el.rel);
      if (tag === 'script' && !el.src && el.textContent && !inline.has(el)) {
        inline.add(el);
        const body = el.textContent;
        scanText(body.slice(0, MAX_FILE), 'inline-script');
        if (body.length * 3 <= MAX_FILE && totalBytes + body.length * 3 <= MAX_TOTAL) {
          totalBytes += body.length * 3;
          emit('artifact', { url: location.href + '#inline-' + inline.size, mime: 'text/javascript', encoding: 'utf8', body, source: 'dom-inline', truncated: false });
        } else emit('gap', { reason: 'inline-script-size-limit' });
      }
    });
  }
  async function capture(response, url, source, requestId) {
    if (busy >= 4 || totalBytes >= MAX_TOTAL) {
      emit('gap', { url, reason: 'capture-budget-or-concurrency' }); return;
    }
    busy++;
    let reader, timer;
    try {
      const mime = response.headers.get('content-type') || 'application/octet-stream';
      if (!response.body || response.type === 'opaque') {
        emit('gap', { url, reason: 'body-unavailable' }); return;
      }
      reader = response.body.getReader(); readers.add(reader);
      const chunks = []; let size = 0, truncated = false;
      const deadline = new Promise((_, reject) => { timer = nativeTimeout(() => reject(new Error('capture-timeout')), 8000); });
      while (true) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        const room = Math.max(0, Math.min(MAX_FILE - size, MAX_TOTAL - totalBytes));
        const part = value.subarray(0, room);
        chunks.push(part); size += part.length; totalBytes += part.length;
        if (part.length < value.length) {
          truncated = true; reader.cancel().catch(() => {}); break;
        }
      }
      const bytes = new Uint8Array(size); let offset = 0;
      chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.length; });
      if (/javascript|json|text|xml/.test(mime)) scanText(new TextDecoder().decode(bytes), source);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      emit('artifact', { url, source, requestId, mime, encoding: 'base64', body: btoa(binary), truncated, status: response.status, bytes: size });
    } catch (error) {
      if (reader) reader.cancel().catch(() => {});
      emit('gap', { url, reason: String(error) });
    } finally { nativeClear(timer); readers.delete(reader); busy--; }
  }
  window.fetch = function (...args) {
    if (!enabled || draining) return originalFetch(...args);
    const input = args[0], options = args[1];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestId = pageId + ':fetch:' + (++sequence);
    emit('request', { requestId, url: String(url), method: options?.method || input?.method || 'GET', api: 'fetch', stack: stack() });
    const promise = originalFetch(...args);
    pendingNetwork.add(requestId);
    promise.then(response => {
      emit('response', { requestId, url: response.url || String(url), status: response.status, redirected: response.redirected });
      if (enabled) { try { capture(response.clone(), response.url || String(url), 'fetch-response', requestId); } catch (error) { emit('gap',{requestId,reason:String(error)}); } }
      pendingNetwork.delete(requestId);
    }, error => { emit('network-error', { requestId, message: String(error) }); pendingNetwork.delete(requestId); });
    return promise;
  };
  const xhrInfo = new WeakMap();
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrInfo.set(this, { method, url: String(url), requestId: pageId + ':xhr:' + (++sequence) });
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (!enabled || draining) return send.apply(this,args);
    const info = xhrInfo.get(this) || {};
    emit('request', { ...info, api: 'xhr', stack: stack() });
    pendingNetwork.add(info.requestId);
    this.addEventListener('loadend', () => {
      emit('response', { ...info, url: this.responseURL || info.url, status: this.status });
      try {
        if (enabled && (!this.responseType || this.responseType === 'text')) {
          const text = this.responseText;
          if (text.length * 3 <= MAX_FILE && totalBytes + text.length * 3 <= MAX_TOTAL) {
            totalBytes += text.length * 3;
            scanText(text, 'xhr-response');
            emit('artifact', { ...info, url: this.responseURL || info.url, status: this.status, mime: this.getResponseHeader('content-type') || 'text/plain', encoding: 'utf8', body: text, source: 'xhr-response', truncated: false });
          } else emit('gap', { ...info, reason: 'xhr-size-limit' });
        }
      } catch (_) { emit('gap', { ...info, reason: 'xhr-body-unavailable' }); }
      finally { pendingNetwork.delete(info.requestId); }
    }, { once: true });
    try { return send.apply(this, args); } catch (error) { pendingNetwork.delete(info.requestId); throw error; }
  };
  ['setTimeout', 'setInterval'].forEach(api => {
    const original = window[api].bind(window);
    window[api] = function (callback, delay, ...args) {
      const timerId = pageId + ':timer:' + (++sequence);
      let fires = 0;
      const wrapped = typeof callback === 'function' ? function (...values) {
        if (++fires <= 20) emit('timer-fire', { timerId, api, fire: fires });
        else if (fires === 21) emit('gap', { timerId, reason: 'timer-fires-sampled-after-20' });
        return callback.apply(this, values);
      } : callback;
      const handle = original(wrapped, delay, ...args);
      emit('timer', { timerId, handle, api, delay: Number(delay) || 0, callback: typeof callback === 'function' ? callback.name || '(anonymous)' : '(string)', stack: stack() });
      return handle;
    };
  });
  ['clearTimeout', 'clearInterval'].forEach(api => {
    const original = window[api].bind(window);
    window[api] = function (handle) { emit('timer-clear', { api, handle }); return original(handle); };
  });
  ['pushState', 'replaceState'].forEach(api => {
    const original = history[api];
    history[api] = function (...args) {
      const result = original.apply(this, args);
      emit('navigation', { api, url: location.href }); link(location.href, api, true); return result;
    };
  });
  const windowOpen = window.open;
  window.open = function (url, ...args) {
    link(String(url || ''), 'window.open', true);
    emit('navigation', { api: 'window.open', url: String(url || '') });
    return windowOpen.call(this, url, ...args);
  };
  if (window.WebSocket) {
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct(Target, args) {
      const socket = Reflect.construct(Target, args);
      emit('websocket', { phase: 'connect', url: String(args[0]), stack: stack() });
      socket.addEventListener('message', event => emit('websocket', { phase: 'received', url: socket.url, size: typeof event.data === 'string' ? event.data.length : event.data.size }));
      const original = socket.send;
      socket.send = function (data) { emit('websocket', { phase: 'sent', url: socket.url, size: typeof data === 'string' ? data.length : data.byteLength ?? data.size }); return original.call(this, data); };
      return socket;
    } });
  }
  document.addEventListener('click', event => {
    const el = event.target?.closest?.('a,button,input,[role="button"]') || event.target;
    emit('action', { action: 'click', target: selector(el), trusted: event.isTrusted });
    if (el?.href) link(el.href, 'click', true);
  }, true);
  document.addEventListener('submit', event => emit('action', { action: 'submit', target: selector(event.target), url: event.target.action }), true);
  document.addEventListener('change', event => emit('action', { action: 'change', target: selector(event.target) }), true);
  ['popstate', 'hashchange'].forEach(api => window.addEventListener(api, () => {
    emit('navigation', { api, url: location.href }); link(location.href, api, true);
  }));
  window.addEventListener('error', event => emit('error', { message: String(event.message || 'resource error'), file: event.filename, line: event.lineno }));
  window.addEventListener('unhandledrejection', event => emit('error', { message: String(event.reason).slice(0, 2000) }));
  try {
    new PerformanceObserver(list => list.getEntries().forEach(entry => {
      emit('resource-timing', { url: entry.name, type: entry.initiatorType, duration: entry.duration, bytes: entry.transferSize });
      if (!['fetch', 'xmlhttprequest', 'beacon'].includes(entry.initiatorType)) resource(entry.name, entry.initiatorType);
    })).observe({ type: 'resource', buffered: true });
  } catch (_) { emit('gap', { reason: 'performance-observer-unavailable' }); }
  function ready() {
    if (!enabled || draining) return;
    scan(document);
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (scheduled || !enabled || draining) return;
      scheduled = true;
      nativeTimeout(() => { scheduled = false; if (enabled && !draining) scan(document); }, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'content', 'data-deeplink'] });
  }
  async function snapshot(download, announce = true, requestId) {
    scan(document);
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('input,textarea,select').forEach(el => {
      el.removeAttribute('value'); el.removeAttribute('checked');
      if (el.tagName === 'TEXTAREA') el.textContent = '';
      if (el.tagName === 'SELECT') el.querySelectorAll('option').forEach(o => o.removeAttribute('selected'));
    });
    const html = '<!doctype html>\n' + clone.outerHTML;
    if (totalBytes + Math.min(html.length, 170000) * 3 <= MAX_TOTAL) {
      totalBytes += Math.min(html.length, 170000) * 3;
      emit('artifact', { url: location.href, mime: 'text/html', encoding: 'utf8', body: html.slice(0, 170000), source: 'dom-snapshot', truncated: html.length > 170000 });
    } else emit('gap', { reason: 'snapshot-budget' });
    if (download) {
      // Re-fetch static resources only, never replay API calls, forms or navigations.
      const candidates = [...resources].filter(([url, type]) => /^https?:/.test(url) && /^(script|link|css|img|image|source|stylesheet|preload|modulepreload|icon)$/.test(type));
      if (candidates.length > 80) emit('gap', { reason: 'resource-replay-limit', skipped: candidates.length - 80 });
      for (const [url] of candidates.slice(0, 80)) {
        if (totalBytes >= MAX_TOTAL) { emit('gap', { reason: 'resource-budget-exhausted' }); break; }
        const controller = new AbortController();
        const timeout = nativeTimeout(() => controller.abort(), 8000);
        try {
          const response = await originalFetch(url, { credentials: 'same-origin', signal: controller.signal });
          await capture(response, url, 'resource-refetch');
        } catch (error) { emit('gap', { url, reason: 'resource-refetch: ' + String(error) }); }
        finally { nativeClear(timeout); }
      }
    }
    if (announce) emit('snapshot-complete', { download, requestId }, true);
  }
  function stop() {
    if (!enabled) return;
    emit('recorder-stopped'); enabled = false;
    if (observer) observer.disconnect();
    readers.forEach(reader => { reader.cancel().catch(() => {}); });
  }
  function finish(requestId) {
    if (!finishPromise) {
      draining = true;
      if (observer) observer.disconnect();
      finishPromise = (async () => {
        try {
          await snapshot(false, false);
          const deadline = Date.now() + 2000;
          while (enabled && (pendingNetwork.size || busy) && Date.now() < deadline) {
            await new Promise(resolve => nativeTimeout(resolve, 25));
          }
          if (pendingNetwork.size || busy) emit('gap', { reason:'finish-drain-timeout', pendingRequestIds:[...pendingNetwork], pendingBodies:busy });
        } catch (error) { emit('snapshot-error', {requestId, reason:String(error)}); }
        finally { stop(); }
      })();
    }
    return finishPromise.then(() => emit('snapshot-complete', { requestId, finalized:true }, true));
  }
  window.__webtrace = { snapshot, stop, finish };
  emit('recorder-started', { readyState: document.readyState, userAgent: navigator.userAgent });
  link(location.href, 'document-url', true);
  if (document.readyState !== 'loading') emit('gap', { reason: 'late-injection' });
  window.addEventListener('pagehide', () => { if (enabled) snapshot(false, false).catch(() => {}); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
}

export const injection = '(' + installRecorder.toString() + ')(); true;';
