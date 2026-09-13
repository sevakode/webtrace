import { fromByteArray } from 'base64-js';
import { nativeArtifact, nativeEvent, Session } from './session';

export const RESOURCE_FILE_LIMIT = 8 * 1024 * 1024;
export const RESOURCE_TOTAL_LIMIT = 16 * 1024 * 1024;
export const staticResourceType = /^(script|link|css|img|image|source|stylesheet|preload|modulepreload|icon|font)$/;
const successful = (e: any) => e.kind === 'artifact' && !e.data.truncated && (e.data.status == null || e.data.status >= 200 && e.data.status < 300);

// Fetch only observed static resources. Never replay payment/API requests.
export async function downloadMissingResources(session: Session, fetcher: typeof fetch, onProgress?: (done: number, total: number) => void) {
  const existing = new Set(session.events.filter(successful).map(e => e.data.url));
  const resources = session.events.filter(e => e.kind === 'resource' && typeof e.data.url === 'string' && /^https?:/.test(e.data.url) && staticResourceType.test(e.data.type));
  resources.sort((a, b) => Number(b.data.type === 'script' || /\.m?js(?:\?|$)/.test(b.data.url)) - Number(a.data.type === 'script' || /\.m?js(?:\?|$)/.test(a.data.url)));
  const candidates = [...new Set(resources.map(e => e.data.url as string))].filter(url => !existing.has(url));
  const deadline = Date.now() + 45000;
  let bytes = 0, completed = 0;
  if (candidates.length > 60) nativeEvent(session, 'gap', { reason: 'native-resource-limit', skipped: candidates.length - 60 });
  for (const url of candidates.slice(0, 60)) {
    onProgress?.(completed, Math.min(60, candidates.length));
    const sessionRoom = Math.floor((24 * 1024 * 1024 - session.chars - 120000) * 0.74);
    const fileLimit = Math.min(RESOURCE_FILE_LIMIT, RESOURCE_TOTAL_LIMIT - bytes, sessionRoom);
    if (Date.now() >= deadline || fileLimit <= 0) {
      nativeEvent(session, 'gap', { reason: 'native-resource-budget', skipped: candidates.length - completed }); break;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('resource-timeout')); }, Math.min(10000, deadline - Date.now()));
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([fetcher(url, { credentials: 'omit', signal: controller.signal }), timeout]);
      if (!response.body) throw new Error('No response stream');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0, truncated = false;
      while (true) {
        const {done, value} = await Promise.race([reader.read(), timeout]);
        if (done) break;
        const chunk = value.subarray(0, Math.max(0, fileLimit - size));
        chunks.push(chunk); size += chunk.length; bytes += chunk.length;
        // Read until done so a file exactly at the limit is not falsely truncated.
        if (chunk.length < value.length) { truncated = true; void reader.cancel().catch(() => {}); break; }
      }
      const body = new Uint8Array(size); let offset = 0;
      chunks.forEach(chunk => { body.set(chunk, offset); offset += chunk.length; });
      const mime = response.headers.get('content-type') || 'application/octet-stream';
      const accepted = nativeArtifact(session, { url, finalUrl: response.url || url, status: response.status,
        source: 'native-resource-refetch', credentials: 'omit', mime, encoding: 'base64',
        body: fromByteArray(body), truncated, bytes: size, contentLength: response.headers.get('content-length'), limitBytes: fileLimit });
      if (!accepted) { nativeEvent(session, 'gap', { url, reason: 'native-artifact-session-limit' }); break; }
      if (truncated) nativeEvent(session, 'gap', { url, reason: 'native-file-truncated', savedBytes: size, limitBytes: fileLimit });
      if (!response.ok) nativeEvent(session, 'gap', { url, reason: 'native-resource-http-error', status: response.status });
      if (/javascript|text|json|xml/.test(mime)) {
        const text = new TextDecoder().decode(body);
        const matches = text.match(/[a-z][a-z0-9+.-]{1,30}:\/\/[^\s"'<>`\\]{1,4096}|intent:[^\s"'<>`]{1,8192}/gi) || [];
        const unique = [...new Set(matches)];
        if (unique.length > 2000) nativeEvent(session, 'gap', { url, reason: 'file-link-limit', skipped: unique.length - 2000 });
        for (const candidate of unique.slice(0, 2000)) {
          try {
            const link = new URL(candidate);
            nativeEvent(session, 'link', { url: link.href, rawUrl: candidate, source:'native-resource-refetch', sourceUrl: url,
              attempted:false, classification:/^https?:$/.test(link.protocol)?'web-link-unverified':'custom-scheme' });
          } catch {}
        }
      }
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {});
      nativeEvent(session, 'gap', { url, reason: 'native-resource-refetch: ' + String(error) });
    } finally { clearTimeout(timer!); completed++; }
  }
  onProgress?.(completed, Math.min(60, candidates.length));
}
