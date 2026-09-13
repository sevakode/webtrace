import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { fromByteArray } from 'base64-js';
import { makeArchive, nativeEvent, Session, summarize, captureCoverage } from '../src/session';
import { downloadMissingResources } from '../src/resources';

async function main() {
  const [input, output, ...flags] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: tsx scripts/enrich-archive.ts input.zip output.zip [--fetch-static]');
  const files = unzipSync(await readFile(input));
  const metadata = JSON.parse(strFromU8(files['session.json']));
  const events = strFromU8(files['events.jsonl']).split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const event of events) {
    if (event.kind !== 'artifact' || !event.data.path) continue;
    const bytes = files[event.data.path];
    if (!bytes) throw new Error('Missing archived body: ' + event.data.path);
    event.data = { ...event.data, encoding:'base64',body:fromByteArray(bytes) };
    delete event.data.path;
  }
  const session: Session = {...metadata, events, chars:events.reduce((size,e)=>size+JSON.stringify(e).length,0), dropped:metadata.dropped || 0};
  nativeEvent(session,'archive-enrichment',{originalSessionId:metadata.id,originalEndedAt:metadata.endedAt,at:new Date().toISOString(),staticRefetch:flags.includes('--fetch-static')});
  if(flags.includes('--fetch-static')) await downloadMissingResources(session,fetch);
  await writeFile(output,makeArchive(session));
  const summary=summarize(session);
  console.log(JSON.stringify({events:summary.events,artifacts:summary.artifacts,links:summary.links.length,categories:summary.links.reduce((r,l)=>({...r,[l.category]:(r[l.category]||0)+1}),{} as Record<string,number>),coverage:captureCoverage(session)},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
