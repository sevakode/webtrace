import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromByteArray } from 'base64-js';
import { unzipSync, strFromU8 } from 'fflate';
import { downloadMissingResources, RESOURCE_FILE_LIMIT } from '../src/resources';
import { newSession, nativeEvent, nativeArtifact, makeArchive, captureCoverage, ingest } from '../src/session';

test('recovers script over bridge limit completely, retaining evidence of original truncation', async () => {
  const session = newSession('https://example.test');
  const url = 'https://example.test/app.js';
  nativeEvent(session, 'resource', {url,type:'script'});
  nativeArtifact(session,{url,source:'resource-refetch',encoding:'base64',body:fromByteArray(new Uint8Array(524288)),truncated:true});
  assert.equal(captureCoverage(session).truncatedUnrecovered.length,1);
  const source = '/*'+ 'x'.repeat(1100000)+'*/ const url="latebank://route/9";';
  const fake = async () => new Response(source,{headers:{'content-type':'application/javascript'}});
  await downloadMissingResources(session,fake as typeof fetch);
  const zip=unzipSync(makeArchive(session));
  const manifest=JSON.parse(strFromU8(zip['manifest.json']));
  const restored=manifest.find((f:any)=>f.source==='native-resource-refetch');
  assert(restored && !restored.truncated);
  assert.equal(strFromU8(zip[restored.path]),source);
  assert.equal(captureCoverage(session).truncatedUnrecovered.length,0);
  assert.equal(captureCoverage(session).truncated[0].replacementAvailable,true);
  assert(session.events.some(e=>e.kind==='link' && e.data.url==='latebank://route/9'));
});

test('native 8 MiB file boundary, oversized bridge messages and HTTP failures stay explicit', async () => {
  const session=newSession('https://example.test');
  nativeEvent(session,'resource',{url:'https://example.test/exact.js',type:'script'});
  const fake=async()=>new Response(new Uint8Array(RESOURCE_FILE_LIMIT),{headers:{'content-type':'application/javascript'}});
  await downloadMissingResources(session,fake as typeof fetch);
  const artifact=session.events.find(e=>e.kind==='artifact')!;
  assert.equal(artifact.data.bytes,RESOURCE_FILE_LIMIT);
  assert.equal(artifact.data.truncated,false);
  const before=session.events.length;
  assert.equal(ingest(session,JSON.stringify(artifact)),false,'page bridge must retain small-message boundary');
  assert.equal(session.events.length,before);
  const bad=newSession('https://example.test');
  nativeEvent(bad,'resource',{url:'https://example.test/missing.js',type:'script'});
  await downloadMissingResources(bad,(async()=>new Response('not found',{status:404})) as typeof fetch);
  assert.equal(captureCoverage(bad).missing.length,1);
  assert(bad.events.some(e=>e.kind==='gap' && e.data.status===404));
});
