import {readFileSync,writeFileSync,mkdirSync,readdirSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Serve the full audit export as a versioned asset so the Worker does not hold
// the large candidate-quote tree in memory just to serialize a download.
const body=readFileSync('lib/data/market-snapshot.json');
if(body.length>=25*1024*1024)throw new Error('Snapshot exceeds the per-asset hosting limit; split the export before publishing.');
const file='equity-snapshot-'+createHash('sha256').update(body).digest('hex').slice(0,16)+'.json';
const dir='public/data';mkdirSync(dir,{recursive:true});writeFileSync(dir+'/'+file,body);
for(const old of readdirSync(dir))if(/^equity-snapshot-[a-f0-9]{16}\.json$/.test(old)&&old!==file)unlinkSync(dir+'/'+old);
writeFileSync('lib/data/snapshot-asset.json',JSON.stringify({path:'/data/'+file}));
console.log('Prepared audit asset:',body.length,'bytes');
