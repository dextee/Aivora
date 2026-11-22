import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

const browser = 'dummy-browser-credential';
const server = 'dummy-server-credential';
async function boot(key = '') {
  const mock = `const original=globalThis.fetch; globalThis.fetch=async (url,init)=>{if(String(url).includes('maas.aliyuncs.com')){const expected=${JSON.stringify(key || browser)}; if(init.headers.Authorization!=='Bearer '+expected) return new Response('wrong credential',{status:401}); const body=JSON.parse(init.body); const messages=body.input?.messages||body.messages; const text=messages.at(-1).content[0].text; if(text.includes('failure')) throw Error(expected); return new Response('data: '+JSON.stringify({output:{choices:[{message:{content:[{text:'Sell 123 products via FNYGlobal'}]}}]}})+'\\n\\n');} return original(url,init);};`;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(mock), 'server.mjs'], {
    cwd: new URL('../', import.meta.url), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOST:'127.0.0.1', PORT: key ? '8397' : '8396', AIVORA_MEMORY_MODE:'1', DASHSCOPE_API_KEY:key }, stdio:['ignore','pipe','pipe'],
  });
  const base = `http://127.0.0.1:${key ? 8397 : 8396}`;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok) return {child,base};}catch{} await new Promise(r=>setTimeout(r,100));}
  child.kill(); throw Error('isolated server failed to boot');
}
async function stop(child) { if(child.exitCode===null){child.kill(); await once(child,'exit');} }
const headers = {'content-type':'application/json','x-aivora-auth':encodeURIComponent(JSON.stringify({key:browser,ws:'ws-test',region:'ap-southeast-1'})),Authorization:'Bearer dummy-supabase-token'};
async function post(base,path,text,h=headers,source='typed'){return (await fetch(base+path,{method:'POST',headers:h,body:JSON.stringify({text,source})})).json();}

test('browser credentials reach mocked Qwen interpretation through submit and objectives; voice/text parity, safe views', async()=>{
  const {child,base}=await boot();
  try {
    for(const [path,source] of [['/api/odai/submit','voice'],['/api/odai/submit','typed'],['/api/odai/objectives','typed']]){
      const result=await post(base,path,'Sell 123 products via FNYGlobal',headers,source);
      assert.equal(result.planning?.provider_status,'responded'); assert.equal(result.planning.task_graph,'fixed_native'); assert.equal(result.tasks.length,11);
      const saved=await (await fetch(base+'/api/odai/objectives/'+result.objective_id)).json();
      const trace=await (await fetch(base+'/api/odai/view?mode=management')).json();
      for(const secret of [browser,'dummy-supabase-token']) assert.ok(!JSON.stringify([result,saved,trace]).includes(secret));
    }
    const failure=await post(base,'/api/odai/submit','failure Sell 123 products via FNYGlobal');
    assert.equal(failure.code,'PLANNER_UNAVAILABLE'); assert.ok(!JSON.stringify(failure).includes(browser));
    const missing=await post(base,'/api/odai/submit','Sell 123 products via FNYGlobal',{'content-type':'application/json'});
    assert.equal(missing.planning.provider_status,'not_configured'); assert.equal(missing.planning.source,'native');
  } finally {await stop(child);}
});
test('server key overrides browser key in actual mocked provider request',async()=>{
  const {child,base}=await boot(server); try {const result=await post(base,'/api/odai/submit','Sell 123 products via FNYGlobal'); assert.equal(result.planning.provider_status,'responded'); assert.ok(!JSON.stringify(result).includes(server));}finally{await stop(child);}
});
test('all objective creation surfaces send browser auth; existing voice and text share intent handler',()=>{
  for(const file of ['GoalsView.tsx','PlanView.tsx','MyStoreView.tsx']) assert.match(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),/\.\.\.authHeader\(\)/);
  const talk=readFileSync(new URL('../src/TalkView.tsx',import.meta.url),'utf8'); assert.match(talk,/tryIntentMatch\(e.text\)/); assert.match(talk,/tryIntentMatch\(text\)/); assert.match(talk,/x-aivora-auth/);
});
