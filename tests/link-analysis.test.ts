import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLinks, rawLinkObservations, type LinkObservation } from '../src/link-analysis';

function event(url: string, source = 'native-resource-refetch', attempted = false, id = url): LinkObservation {
  return { kind: 'link', id, data: { url, source, attempted, classification: 'custom-scheme' } };
}

test('separates internal pseudo URLs, documentation, resources, web URLs and app candidates', () => {
  const cases = [
    ['server://singlefetch/', 'technical', 'custom-scheme'],
    ['http://www.w3.org/2000/svg', 'technical', 'web-link-unverified'],
    ['http://www.w3.org/1998/Math/MathML', 'technical', 'web-link-unverified'],
    ['https://react.dev/errors/', 'technical', 'web-link-unverified'],
    ['https://reactrouter.com/en/main/routers/picking-a-router', 'technical', 'web-link-unverified'],
    ['https://github.com/ungap/url-search-params', 'technical', 'web-link-unverified'],
    ['http://localhost/', 'technical', 'web-link-unverified'],
    ['http://127.0.0.1:8081/', 'technical', 'web-link-unverified'],
    ['http://[::1]:8081/', 'technical', 'web-link-unverified'],
    ['https://cdn.example/font.woff2?v=1', 'resource', 'web-link-unverified'],
    ['https://cdn.example/img/logo/Bank', 'resource', 'web-link-unverified'],
    ['https://cdn.example/app.js?version=1', 'resource', 'web-link-unverified'],
    ['https://bank.example/transfer?amount=10', 'web', 'web-link-unverified'],
    ['bankffinlink://', 'app-candidate', 'custom-scheme'],
    ['unknownbank://transfer', 'app-candidate', 'custom-scheme'],
  ] as const;
  const result = analyzeLinks(cases.map(([url]) => event(url)));
  for (const [url, category, classification] of cases) {
    const link = result.find(link => link.url === url);
    assert.equal(link?.category, category, url);
    assert.equal(link?.classification, classification, url);
    assert.equal(link?.attempted, false, url);
  }
  assert.match(result.find(link => link.url === 'unknownbank://transfer')!.reasons.join(' '), /unverified/);
});

test('cleans CSS and documentation punctuation, deduplicates canonical URL, preserves raw evidence', () => {
  const raw = 'https://fonts.gstatic.com/s/manrope/v20/font.woff2)';
  const input = [
    event(raw, 'native-resource-refetch', false, 'css:1'),
    event('https://fonts.gstatic.com/s/manrope/v20/font.woff2', 'resource-refetch', false, 'css:2'),
    event('https://reactrouter.com/en/main/routers/picking-a-router.'),
    event('https://github.com/ungap/url-search-params.'),
    event('https://example.test/Foo_(bar)'),
    event('https://example.test/image.png);'),
  ];
  const original = JSON.stringify(input);
  const links = analyzeLinks(input);
  assert.equal(links.length, 5);
  assert.deepEqual(links[0].rawUrls, [raw, 'https://fonts.gstatic.com/s/manrope/v20/font.woff2']);
  assert.deepEqual(links[0].evidence, ['css:1', 'css:2']);
  assert.deepEqual(links[0].sources, ['native-resource-refetch', 'resource-refetch']);
  assert.equal(links[0].category, 'resource');
  assert(links.some(link => link.url === 'https://github.com/ungap/url-search-params'));
  assert(links.some(link => link.url === 'https://reactrouter.com/en/main/routers/picking-a-router'));
  assert(links.some(link => link.url === 'https://example.test/Foo_(bar)'));
  assert(links.some(link => link.url === 'https://example.test/image.png'));
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(rawLinkObservations(input), input);
});

test('never changes literal navigation punctuation or encoded URL characters', () => {
  const cases = [
    event('bankapp://pay?reference=123)', 'native-navigation', true),
    event('https://react.dev/path.', 'dom-anchor'),
    event('https://example.test/pay?reference=123.', 'fetch-response'),
    event('https://example.test/pay?reference=123%29', 'native-resource-refetch'),
  ];
  assert.deepEqual(analyzeLinks(cases).map(link => link.url), cases.map(e => e.data.url));
});

test('marks JavaScript interpolations as templates even after URL normalization', () => {
  const raw = [
    'https://web5.online.sberbank.ru/transfers?phoneNumber=${N1(t)}',
    'https://web5.online.sberbank.ru/transfers?phoneNumber=${t}',
    'bankapp://transfer/${account}/open',
    'https://example.test/${payment}/open',
    'https://example.test/pay?phone=%24%7Bphone%7D',
  ];
  const links = analyzeLinks(raw.map(value => event(new URL(value).href)));
  assert(links.every(link => link.category === 'template'));
  assert(links.every(link => !link.attempted));
});

test('preserves full Android intent syntax and discovers fallback URLs without pretending they were opened', () => {
  const fallback = 'https://bank.example/fallback?redirect=bankapp%3A%2F%2Fpay%3Fcode%3D2';
  const intent = `intent://pay/42#Intent;scheme=bankapp;package=com.bank.app;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  const androidApp = 'android-app://com.bank.app/https/bank.example/pay#Intent;scheme=https;package=com.bank.app;end';
  const links = analyzeLinks([event(intent, 'native-navigation', true), event(androidApp), event(intent + ');')]);
  const observed = links.find(link => link.url === intent)!;
  assert.equal(observed.attempted, true);
  assert.equal(observed.category, 'app-candidate');
  assert(links.some(link => link.url === androidApp));
  assert(links.some(link => link.url === fallback && !link.attempted));
  assert(links.some(link => link.url === 'bankapp://pay?code=2' && !link.attempted));
  assert(!links.some(link => link.url.endsWith(');')));
});

test('expands query links from native observations through two levels and merges actual attempts', () => {
  const depth3 = 'toodeep://do-not-expand';
  const depth2 = 'bankapp://pay?next=' + encodeURIComponent(depth3);
  const depth1 = 'https://bank.example/redirect?target=' + encodeURIComponent(depth2);
  const outer = 'https://short.example/open?af_dp=' + encodeURIComponent(depth1);
  const links = analyzeLinks([
    event(outer, 'native-resource-refetch', true, 'native:1'),
    event(depth2, 'native-navigation', true, 'native:2'),
  ]);
  const nested = links.find(link => link.url === depth1)!;
  assert.equal(nested.attempted, false);
  assert.deepEqual(nested.derivedFrom, [outer]);
  assert(nested.sources.includes('native-resource-refetch'));
  assert(nested.sources.includes('nested-query'));
  const attempted = links.find(link => link.url === depth2)!;
  assert.equal(attempted.attempted, true);
  assert.deepEqual(attempted.evidence, ['native:1', 'native:2']);
  // The depth-3 URL is only discovered through its separate, directly observed parent.
  assert.deepEqual(links.find(link => link.url === depth3)?.evidence, ['native:2']);
  assert(!analyzeLinks([event(outer)]).some(link => link.url === depth3));
});

test('handles twice-encoded native query links, malformed URLs and bounded nested expansion', () => {
  const target = 'bankffinlink://';
  const links = analyzeLinks([
    event('https://short.example/open?target=' + encodeURIComponent(encodeURIComponent(target))),
    event('https://['),
    event('https://bank.example/?bad=%E0%A4%A'),
  ]);
  assert(links.some(link => link.url === target));
  assert.equal(links.find(link => link.url === 'https://[')?.category, 'technical');
  const manyParams = Array.from({ length: 100 }, (_, index) => `p${index}=${encodeURIComponent('bankapp://pay/' + index)}`).join('&');
  const many = analyzeLinks([event('https://short.example/?' + manyParams)]);
  assert.equal(many.length, 65);
  assert(many[0].reasons.includes('nested-expansion-limit'));
});

test('retains raw malformed events and ignores non-link data', () => {
  const malformed: LinkObservation = { kind: 'link', id: 'malformed', data: { url: 123 } };
  const resource: LinkObservation = { kind: 'resource', id: 'asset', data: { url: 'https://cdn.test/app.js' } };
  assert.deepEqual(rawLinkObservations([malformed, resource]), [malformed]);
  assert.deepEqual(analyzeLinks([malformed, resource]), []);
});
