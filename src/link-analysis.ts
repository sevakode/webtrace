import type { TraceEvent } from './session';

export type LinkCategory = 'app-candidate' | 'web' | 'resource' | 'technical' | 'template';
export type LinkObservation = Pick<TraceEvent, 'id' | 'kind' | 'data'>;
export type AnalyzedLink = {
  url: string;
  /** Legacy scheme classification; category is the interpretation of the evidence. */
  classification: 'custom-scheme' | 'web-link-unverified';
  category: LinkCategory;
  /** An observed attempt is not proof that an app opened or a payment succeeded. */
  attempted: boolean;
  evidence: string[];
  sources: string[];
  rawUrls: string[];
  /** Parents containing this URL as a parameter; these are discoveries, not redirects. */
  derivedFrom: string[];
  reasons: string[];
};

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const STATIC_SOURCE = /(?:refetch|script|stylesheet|css|artifact|response|snapshot|inline|scan|document-text)/i;
const TECHNICAL_SCHEMES = new Set(['server:', 'node:', 'webpack:', 'webpack-internal:', 'chrome:', 'chrome-extension:', 'devtools:', 'about:', 'javascript:', 'data:', 'blob:', 'file:', 'resource:']);
const DOC_HOSTS = new Set(['react.dev', 'reactjs.org', 'reactrouter.com', 'reactnative.dev', 'w3.org', 'www.w3.org', 'developer.mozilla.org', 'i18next.com', 'www.i18next.com', 'docs.github.com', 'electron']);
const RESOURCE_EXTENSION = /\.(?:m?js|cjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|bmp|mp[34]|m4[av]|webm|ogg|wav|pdf)(?:$|\/)/i;
const MAX_URL_LENGTH = 32768;
const MAX_NESTED_PER_EVENT = 64;
const MAX_NESTED_TOTAL = 6000;

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isTemplate(value: string): boolean {
  // URL.href may percent-encode braces in a path before the event reaches native code.
  return /\$\{[^}]*\}?/.test(value) || /\$\{[^}]*\}?/.test(decode(value));
}

function isDocumentation(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (DOC_HOSTS.has(host)) return true;
  // GitHub repository links in bundles are library/documentation references.
  return host === 'github.com' || host === 'www.github.com';
}

/** Clean only static text discoveries. A literal URL used in navigation is untouched. */
function cleanStaticUrl(raw: string, source: string, attempted: boolean): string {
  let value = raw.trim();
  if (attempted || !STATIC_SOURCE.test(source)) return value;
  // Preserve the complete Android intent grammar, including its semicolons.
  if (/^(?:intent|android-app):/i.test(value) && /#Intent;/i.test(value)) {
    return value.replace(/(;end)[)\]},.]+;?$/i, '$1');
  }
  // Quotes cannot be part of an unescaped scanned string; encoded quotes are left intact.
  value = value.replace(/["'`]+$/, '');
  let parsed: URL | undefined;
  try { parsed = new URL(value); } catch { /* Keep invalid observations for inspection. */ }
  // A final dot in a copied documentation sentence is not part of the reference.
  // Do not apply this to arbitrary URLs whose query/path may deliberately end in a dot.
  if (parsed && isDocumentation(parsed) && !parsed.search && !parsed.hash) value = value.replace(/[.,;:]+$/, '');
  if (!isTemplate(value)) {
    // A scanner begins at the scheme, so the closing ')' of CSS url(...) is unmatched.
    // Balanced parentheses in genuine URL paths and query values must survive.
    const open = (value.match(/\(/g) || []).length;
    let close = (value.match(/\)/g) || []).length;
    value = value.replace(/\);$/, ')');
    while (value.endsWith(')') && close > open) { value = value.slice(0, -1); close--; }
  }
  return value;
}

function classify(value: string, parsed?: URL): { category: LinkCategory; reason: string } {
  if (isTemplate(value)) return { category: 'template', reason: 'unresolved-javascript-interpolation' };
  if (!parsed) return { category: 'technical', reason: 'invalid-or-unsupported-url' };
  const host = parsed.hostname.toLowerCase();
  if (TECHNICAL_SCHEMES.has(parsed.protocol)) return { category: 'technical', reason: 'internal-or-non-app-scheme' };
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '0.0.0.0') {
    return { category: 'technical', reason: 'local-development-address' };
  }
  if (isDocumentation(parsed)) return { category: 'technical', reason: 'documentation-or-namespace-reference' };
  if (/^https?:$/.test(parsed.protocol)) {
    if (RESOURCE_EXTENSION.test(parsed.pathname) || /\/(?:assets|fonts|images|img)\//i.test(parsed.pathname) || host === 'fonts.gstatic.com' || host === 'fonts.googleapis.com') {
      return { category: 'resource', reason: 'static-resource-url' };
    }
    return { category: 'web', reason: 'unverified-web-link' };
  }
  return { category: 'app-candidate', reason: 'scheme-found-app-association-unverified' };
}

function nestedValues(url: URL): { value: string; parameter: string }[] {
  const values: { value: string; parameter: string }[] = [];
  url.searchParams.forEach((value, parameter) => values.push({ value, parameter }));
  if (/^(?:intent|android-app):$/.test(url.protocol) && url.hash.startsWith('#Intent;')) {
    for (const field of url.hash.slice(8).split(';')) {
      const equals = field.indexOf('=');
      if (equals !== -1) values.push({ parameter: field.slice(0, equals), value: field.slice(equals + 1) });
    }
  }
  return values;
}

/** All original events, including malformed URL observations, for links-raw.json. */
export function rawLinkObservations<T extends LinkObservation>(events: readonly T[]): T[] {
  return events.filter(event => event.kind === 'link');
}

/**
 * Interpretation of recorded strings only: no network, app association verification, or execution.
 * Input events are not changed. Parent query links never inherit an attempted flag.
 * Nested expansion is limited to two levels, 64 discoveries/event and 6000/call.
 * Every original URL is retained even if nested expansion reaches its bound.
 */
export function analyzeLinks(events: readonly LinkObservation[]): AnalyzedLink[] {
  type Entry = { link: AnalyzedLink; ids: Set<string>; sources: Set<string>; raw: Set<string>; parents: Set<string>; reasons: Set<string> };
  const links = new Map<string, Entry>();
  let totalDerived = 0;
  for (const event of events) {
    if (event.kind !== 'link' || typeof event.data.url !== 'string') continue;
    const source = typeof event.data.source === 'string' ? event.data.source : 'unknown';
    let eventDerived = 0;
    const queue = [{ raw: event.data.url, attempted: event.data.attempted === true, depth: 0, parent: '', parameter: '' }];
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      const cleaned = item.raw.length <= MAX_URL_LENGTH ? cleanStaticUrl(item.raw, source, item.attempted) : item.raw;
      let parsed: URL | undefined;
      if (cleaned.length <= MAX_URL_LENGTH) {
        try { parsed = new URL(cleaned); } catch { /* Report invalid raw strings too. */ }
      }
      const url = parsed?.href ?? cleaned;
      const classification = /^https?:/i.test(parsed?.protocol ?? url) ? 'web-link-unverified' : 'custom-scheme';
      const interpretation = classify(cleaned, parsed);
      let entry = links.get(url);
      if (!entry) {
        entry = {
          link: { url, classification, category: interpretation.category, attempted: false, evidence: [], sources: [], rawUrls: [], derivedFrom: [], reasons: [] },
          ids: new Set(), sources: new Set(), raw: new Set(), parents: new Set(), reasons: new Set(),
        };
        links.set(url, entry);
      }
      entry.link.attempted ||= item.attempted;
      entry.ids.add(event.id);
      entry.sources.add(source);
      entry.raw.add(item.raw);
      entry.reasons.add(interpretation.reason);
      if (cleaned !== item.raw.trim()) entry.reasons.add('static-text-trailing-punctuation-removed');
      if (item.raw.length > MAX_URL_LENGTH) entry.reasons.add('url-analysis-length-limit');
      if (item.parent) {
        entry.parents.add(item.parent);
        entry.sources.add('nested-query');
        entry.reasons.add('nested-parameter:' + item.parameter);
      }
      if (!parsed || item.depth >= 2) continue;
      for (const nested of nestedValues(parsed)) {
        let candidate = nested.value.trim();
        for (let pass = 0; pass < 2 && !SCHEME.test(candidate); pass++) candidate = decode(candidate);
        if (!SCHEME.test(candidate) || candidate === url) continue;
        if (eventDerived >= MAX_NESTED_PER_EVENT || totalDerived >= MAX_NESTED_TOTAL) {
          entry.reasons.add('nested-expansion-limit');
          break;
        }
        eventDerived++;
        totalDerived++;
        queue.push({ raw: candidate, attempted: false, depth: item.depth + 1, parent: url, parameter: nested.parameter });
      }
    }
  }
  return [...links.values()].map(({ link, ids, sources, raw, parents, reasons }) => ({
    ...link, evidence: [...ids], sources: [...sources], rawUrls: [...raw], derivedFrom: [...parents], reasons: [...reasons],
  }));
}
