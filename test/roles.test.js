import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { DiscordTransport, rolePermissions } from '../src/discord-transport.js';
import { RoleWorker } from '../src/role-worker.js';
const config={guildId:'100000000000000002',roleId:'100000000000000003'};
const authorization={contractVersion:2,guildId:config.guildId,settingsRevision:'1',managedRoleIds:[config.roleId],nicknameEnabled:true};
const user='100000000000000005',bot='100000000000000006',botRole='100000000000000007';
const roles=()=>[{id:config.guildId,position:0,permissions:'0'},{id:config.roleId,position:1,permissions:'0',managed:false},{id:botRole,position:2,permissions:PermissionFlagsBits.ManageRoles.toString()}];
const job=(changes={})=>({id:'10000000-0000-4000-8000-000000000001',...config,guildId:config.guildId,discordUserId:user,roleId:config.roleId,leaseToken:'t'.repeat(43),version:'1',authorization,kind:'verification',semester:null,desired:true,expiresAt:new Date(Date.now()+60000).toISOString(),...changes});
test('hierarchy, managed roles and missing Manage Roles fail closed',()=>{
  const own={roles:[botRole]};assert.equal(rolePermissions(roles(),own,config,config.roleId).id,config.roleId);
  for(const change of [{position:2},{managed:true}]){const values=roles();Object.assign(values[1],change);assert.throws(()=>rolePermissions(values,own,config,config.roleId),/Discord reconciliation failed/);}
  assert.throws(()=>rolePermissions(roles(),{roles:[]},config,config.roleId));assert.throws(()=>rolePermissions(roles(),own,config,config.guildId));
});
function transport({memberRoles=[],memberError,ownError,onGet=()=>{}}={}){
  const writes=[];const rest={get:async(route,options)=>{assert.ok(options.signal);onGet(route);if(route.endsWith('/roles'))return roles();if(route.endsWith(bot)){if(ownError)throw ownError;return{roles:[botRole]};}if(memberError)throw memberError;return{roles:memberRoles};},put:async(route,options)=>{assert.ok(options.signal);writes.push(['PUT',route]);},delete:async(route)=>writes.push(['DELETE',route])};
  return{client:new DiscordTransport(rest,config,bot),writes};
}
test('only the configured single role changes; already correct state is a no-op',async()=>{
  let t=transport();await t.client.apply(job());assert.deepEqual(t.writes,[['PUT',`/guilds/${config.guildId}/members/${user}/roles/${config.roleId}`]]);
  t=transport({memberRoles:[config.roleId,'100000000000000099']});await t.client.apply(job({desired:false}));assert.deepEqual(t.writes,[['DELETE',`/guilds/${config.guildId}/members/${user}/roles/${config.roleId}`]]);
  t=transport({memberRoles:[config.roleId]});await t.client.apply(job());assert.equal(t.writes.length,0);
});
test('expired or foreign jobs cannot mutate Discord; absent members are distinct from missing bot permission',async()=>{
  const t=transport();for(const changes of [{expiresAt:new Date(Date.now()-1).toISOString()},{roleId:'100000000000000099'},{guildId:'100000000000000099'}])await assert.rejects(t.client.apply(job(changes)));assert.equal(t.writes.length,0);
  const missing={status:404,code:10007};await assert.rejects(transport({memberError:missing}).client.apply(job()),error=>error.code==='member_absent');await transport({memberError:missing}).client.apply(job({desired:false}));
  await assert.rejects(transport({ownError:missing}).client.apply(job({desired:false})),error=>error.code==='configuration_error');
});
test('lease is checked again before mutation after slow permission/member reads',async()=>{
  let now=Date.now();const base=now;const t=transport({onGet:()=>{now+=19000;}});t.client.clock=()=>now;
  await assert.rejects(t.client.apply(job({expiresAt:new Date(base+60000).toISOString()})));assert.equal(t.writes.length,0);
});
test('worker is single-flight and sequential; applies only after valid claim and acknowledges version',async()=>{
  let resolve,claims=0,active=0,peak=0;const acks=[];const jobs=[job(),job({id:'10000000-0000-4000-8000-000000000002'})];
  const api={claim:()=>{claims++;return new Promise(r=>{resolve=r;});},ack:async(j,outcome)=>acks.push([j.version,outcome])};
  const worker=new RoleWorker(api,{apply:async()=>{peak=Math.max(peak,++active);await Promise.resolve();active--;}},config,{log:()=>{}});
  const first=worker.tick();assert.equal(worker.tick(),first);assert.equal(claims,1);resolve(jobs);await first;assert.equal(peak,1);assert.deepEqual(acks,[['1','applied'],['1','applied']]);
});
test('failed mutations, stale acks and restart claims converge without treating failure as applied',async()=>{
  const outcomes=[];let claims=0;const api={claim:async()=>{claims++;return[job()];},ack:async(_j,outcome)=>{outcomes.push(outcome);if(claims===1)throw{status:409};}};
  const first=new RoleWorker(api,{apply:async()=>{throw{code:'member_absent',message:'sensitive body'};}},config,{log:()=>{}});await first.tick();assert.deepEqual(outcomes,['member_absent']);
  const restarted=new RoleWorker(api,{apply:async()=>{}},config,{log:()=>{}});await restarted.tick();assert.deepEqual(outcomes,['member_absent','applied']);
});
test('unknown role is configuration-error ack only, API outage never grants and repeated failures log once',async()=>{
  const acks=[],logs=[];let unavailable=false;const api={claim:async()=>{if(unavailable)throw new Error('sensitive');return[job({roleId:'100000000000000099'})];},ack:async(_j,outcome)=>acks.push(outcome)};
  const worker=new RoleWorker(api,{apply:async()=>assert.fail('foreign role')},config,{log:code=>logs.push(code)});await worker.tick();assert.deepEqual(acks,['configuration_error']);unavailable=true;await worker.tick();await worker.tick();assert.deepEqual(logs,['role_configuration_error','role_api_unavailable']);
  worker.stop();const count=logs.length;await worker.tick();assert.equal(logs.length,count);
});
test('a lease that expires during an external mutation never sends a stale applied acknowledgement',async()=>{
  let now=Date.now();const expiry=now+60000;let acked=0;
  const worker=new RoleWorker({claim:async()=>[job({expiresAt:new Date(expiry).toISOString()})],ack:async()=>acked++},{apply:async()=>{now=expiry+1;}},config,{clock:()=>now,log:()=>{}});
  await worker.tick();assert.equal(acked,0);
});
test('configuration failures stay unhealthy across unrelated successes, empty polls and stale recovery acknowledgements',async()=>{
  const first=job(),other=job({id:'10000000-0000-4000-8000-000000000002'});let batch=[first,other],broken=true,stale=false;const logs=[];
  const worker=new RoleWorker({claim:async()=>batch,ack:async()=>{if(stale)throw{status:409};}},
    {apply:async j=>{if(broken&&j.id===first.id)throw{code:'configuration_error'};}},config,{log:code=>logs.push(code)});
  await worker.tick();assert.equal(worker.isHealthy(),false);assert.equal(worker.failed,false);
  batch=[];await worker.tick();assert.equal(worker.isHealthy(),false);
  batch=[first];await worker.tick();assert.equal(logs.filter(code=>code==='role_configuration_error').length,1);
  broken=false;stale=true;await worker.tick();assert.equal(worker.isHealthy(),false);
  stale=false;await worker.tick();assert.equal(worker.isHealthy(),true);assert.equal(logs.at(-1),'role_configuration_recovered');
});
test('member absence alone is healthy, but API outage and an old successful claim are not',async()=>{
  let now=Date.now(),unavailable=false;const logs=[];
  const worker=new RoleWorker({claim:async()=>{if(unavailable)throw Error('private');return[job()];},ack:async()=>{}},
    {apply:async()=>{throw{code:'member_absent'};}},config,{clock:()=>now,log:code=>logs.push(code)});
  await worker.tick();assert.equal(worker.isHealthy(),true);assert.deepEqual(logs,[]);
  now+=120000;assert.equal(worker.isHealthy(),false);
  unavailable=true;await worker.tick();assert.equal(worker.isHealthy(),false);
});
test('real Discord REST transport rejects throttling immediately and enforces a five-second request deadline',async()=>{
  const { REST }=await import('discord.js');const { REST_OPTIONS }=await import('../src/discord-transport.js');
  const { createServer }=await import('node:http');const { once }=await import('node:events');
  let delayed=false;const server=createServer((req,res)=>{if(!delayed){res.writeHead(429,{'content-type':'application/json','retry-after':'60'}).end(JSON.stringify({global:true,retry_after:60}));return;}const timer=setTimeout(()=>res.writeHead(204).end(),6500);req.on('close',()=>clearTimeout(timer));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const api=`http://127.0.0.1:${server.address().port}`;
  const rest=new REST({...REST_OPTIONS,api,makeRequest:fetch}).setToken('synthetic-token');
  try {
    const start=Date.now();await assert.rejects(rest.put(`/guilds/${config.guildId}/members/${user}/roles/${config.roleId}`),error=>error.name.startsWith('RateLimitError'));assert.ok(Date.now()-start<1000);
    delayed=true;const second=new REST({...REST_OPTIONS,api,makeRequest:fetch}).setToken('synthetic-token');const deadline=Date.now();
    try{await assert.rejects(second.put(`/guilds/${config.guildId}/members/${user}/roles/${config.roleId}`));assert.ok(Date.now()-deadline>=4500);assert.ok(Date.now()-deadline<6200);}
    finally{second.clearHashSweeper();second.clearHandlerSweeper();}
  }finally{rest.clearHashSweeper();rest.clearHandlerSweeper();server.closeAllConnections();server.close();await once(server,'close');}
});
test('school, current-member, term and retiring role jobs each touch only their allowlisted role',async()=>{
  const memberRole='100000000000000010',termRole='100000000000000011',retiredRole='100000000000000012';
  const scope={...authorization,settingsRevision:'2',managedRoleIds:[config.roleId,memberRole,termRole,retiredRole]};
  const values=roles();values.find(role=>role.id===botRole).position=5;
  values.push(...[memberRole,termRole,retiredRole].map(id=>({id,position:1,permissions:'0',managed:false})));
  const t=transport({memberRoles:[retiredRole,'100000000000000099']});const original=t.client.rest.get;t.client.rest.get=async(route,options)=>route.endsWith('/roles')?values:original(route,options);
  for(const [roleId,kind,semester,desired] of [[config.roleId,'verification',null,true],[memberRole,'member',null,true],[termRole,'semester','26-2',true],[retiredRole,'member',null,false]])await t.client.apply(job({roleId,kind,semester,desired,authorization:scope}));
  assert.deepEqual(t.writes.map(([method,path])=>[method,path.split('/').at(-1)]),[['PUT',config.roleId],['PUT',memberRole],['PUT',termRole],['DELETE',retiredRole]]);
  await assert.rejects(t.client.apply(job({roleId:memberRole,authorization})),e=>e.code==='configuration_error');assert.equal(t.writes.length,4);
});
