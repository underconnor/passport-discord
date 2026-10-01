import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassportApi } from '../src/api.js';
const config = { guildId: '100000000000000002', roleId: '100000000000000003', apiBase: 'https://api.example.test/', apiToken: 'synthetic-credential-'.repeat(3), webOrigin: 'https://portal.example.test' };
const id = '10000000-0000-4000-8000-000000000001', token = 't'.repeat(43), now = Date.now();
const input = { guildId: config.guildId, discordUserId: '100000000000000005', discordUsername: 'synthetic', interactionId: '100000000000000006' };
const link = () => ({ id, url: `${config.webOrigin}/discord/link/${id}#token=${token}`, expiresAt: new Date(now + 300000).toISOString() });
const job = () => ({ id, guildId: config.guildId, roleId: config.roleId, discordUserId: input.discordUserId, leaseToken: token, version: '1', desired: true, expiresAt: new Date(now + 60000).toISOString() });
test('real HTTP transport binds actor input and sends separate Bearer without redirects or tokens in query', async () => {
  const received=[]; const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received.push({url:req.url,auth:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(link()));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {const api=new PassportApi({...config,apiBase:`http://127.0.0.1:${server.address().port}/`},fetch,()=>now);assert.equal((await api.createLink(input)).url,link().url);assert.deepEqual(received,[{url:'/v1/discord/link-sessions',auth:`Bearer ${config.apiToken}`,body:input}]);}
  finally {server.close();await once(server,'close');}
});
test('malicious, mismatched and expired link responses never reach Discord',async()=>{
  for(const changes of [{url:'https://attacker.example/#token=secret'},{id:'bad'},{url:link().url.replace(id,'10000000-0000-4000-8000-000000000002')},{url:link().url.replace('#','?raw=secret#')},{expiresAt:new Date(now-1).toISOString()},{expiresAt:new Date(now+306000).toISOString()}]){
    const api=new PassportApi(config,async()=>Response.json({...link(),...changes}),()=>now);await assert.rejects(api.createLink(input),error=>error.message==='Passport API request failed'&&!error.cause);
  }
});
test('unknown errors and oversized streamed bodies are discarded; redirects are rejected',async()=>{
  for(const response of [new Response('sensitive-raw-body',{status:503}),Response.json({code:'sensitive-error-token'},{status:403}),new Response('x'.repeat(131073),{status:200}),new Response(null,{status:302,headers:{location:'https://attacker.example'}})]){
    const api=new PassportApi(config,async(_url,options)=>{assert.equal(options.redirect,'error');assert.ok(options.signal);return response;});await assert.rejects(api.createLink(input),error=>!JSON.stringify(error).includes('sensitive')&&error.message==='Passport API request failed');
  }
});
test('claim validates leases, identities, duplicates and type fences without silently applying a different role',async()=>{
  const valid=job();let payload={jobs:[valid]};const api=new PassportApi(config,async()=>Response.json(payload),()=>now);assert.deepEqual(await api.claim(),[valid]);
  for(const jobs of [[{...valid,desired:'true'}],[{...valid,version:'-1'}],[{...valid,leaseToken:'bad'}],[{...valid,expiresAt:new Date(now-1).toISOString()}],[valid,valid],[valid,valid,valid]]){payload={jobs};await assert.rejects(api.claim());}
  payload={jobs:[{...valid,roleId:'100000000000000099'}]};assert.equal((await api.claim())[0].roleId,'100000000000000099'); // worker acks configuration_error; never changes this role
});
test('ack contains only lease fencing and a bounded outcome, never an upstream message',async()=>{
  let sent;const api=new PassportApi(config,async(url,options)=>{sent={url:url.href,body:JSON.parse(options.body)};return new Response(null,{status:204});});await api.ack(job(),'retry');assert.deepEqual(sent.body,{leaseToken:token,version:'1',outcome:'retry'});await assert.rejects(api.ack(job(),'raw error secret'));
});
