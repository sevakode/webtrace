import {readFileSync, writeFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/recorder.js', import.meta.url), 'utf8');
const body = source.slice(0, source.indexOf('\nexport const injection')).replace('export function installRecorder()', 'function installRecorder()');
// Embed source as data: Metro/Hermes must not transform a function before serializing it.
writeFileSync(new URL('../src/recorder-source.json', import.meta.url), JSON.stringify('(' + body.trim() + ')(); true;'));
