import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { DiscordTransport } from '../src/discord-transport.js';
import { NicknameStore } from '../src/nickname-store.js';
import { NicknameWorker } from '../src/nickname-worker.js';
import { RoleWorker } from '../src/role-worker.js';
const config={guildId:'100000000000000002',roleId:'100000000000000003'};
const bot='100000000000000006',user='100000000000000005',botRole='100000000000000007',otherRole='100000000000000008',owner='100000000000000099';
const authorization={contractVersion:2,guildId:config.guildId,settingsRevision:'1',managedRoleIds:[config.roleId],nicknameEnabled:true};
const job=(changes={})=>({id:'10000000-0000-4000-8000-000000000011',guildId:config.guildId,discordUserId:user,leaseToken:'n'.repeat(43),version:'1',expiresAt:new Date(Date.now()+60000).toISOString(),authorization,nickname:'가상 회원 / Synthetic',...changes});
const memoryStore=()=>{let value=null;return {get:async()=>value,set:async(_id,next)=>{value=next;},value:()=>value};};
function transport({current='원래 별명',targetRoles=[],ownerId=owner,nicknamePermission=true,afterPatch,clock=Date.now,onGet=()=>{},store=memoryStore()}={}){
  const writes=[],reads=[];let nick=current;
  const roles=[{id:config.guildId,position:0,permissions:'0'},{id:config.roleId,position:1,permissions:'0',managed:false},{id:botRole,position:3,permissions:(PermissionFlagsBits.ManageRoles|(nicknamePermission?PermissionFlagsBits.ManageNicknames:0n)).toString()},{id:otherRole,position:3,permissions:'0'}];
  const rest={get:async(route,options)=>{assert.ok(options.signal);reads.push(route);onGet(route);if(route.endsWith('/roles'))return roles;if(route===`/guilds/${config.guildId}`)return{owner_id:ownerId};if(route.endsWith(bot))return{roles:[botRole]};return{roles:targetRoles,nick};},
    patch:async(route,options)=>{assert.ok(options.signal);assert.deepEqual(Object.keys(options.body),['nick']);writes.push(['PATCH',route,options.body]);nick=options.body.nick;if(afterPatch)await afterPatch();return{nick};},
    put:async(route)=>writes.push(['PUT',route]),delete:async(route)=>writes.push(['DELETE',route])};
  return{client:new DiscordTransport(rest,config,bot,clock,store),store,writes,reads,current:()=>nick,setCurrent:value=>{nick=value;},rest};
}
test('nickname sync changes only nick and preserves the original across Minecraft-name changes before release',async()=>{
  const t=transport();await t.client.applyNickname(job());assert.equal(t.current(),'가상 회원 / Synthetic');assert.deepEqual(t.store.value(),{originalNickname:'원래 별명',managedNickname:'가상 회원 / Synthetic',phase:'managed'});
  await t.client.applyNickname(job({nickname:'가상 회원 / Renamed'}));assert.equal(t.store.value().originalNickname,'원래 별명');
  await t.client.applyNickname(job({nickname:null}));assert.equal(t.current(),'원래 별명');assert.equal(t.store.value(),null);assert.equal(t.writes.length,3);
  assert.ok(t.writes.every(([method,route,body])=>method==='PATCH'&&route===`/guilds/${config.guildId}/members/${user}`&&Object.keys(body).join()==='nick'));
});
test('matching unmanaged nickname is never claimed and release without ownership is a no-op',async()=>{
  const t=transport({current:job().nickname});await t.client.applyNickname(job());assert.equal(t.store.value(),null);assert.equal(t.writes.length,0);
  const reads=t.reads.length;await t.client.applyNickname(job({nickname:null}));assert.equal(t.reads.length,reads);assert.equal(t.writes.length,0);
});
test('release preserves a manual nickname change and deletes no-longer-needed original names',async()=>{
  const t=transport();await t.client.applyNickname(job());t.setCurrent('운영자가 정한 별명');await t.client.applyNickname(job({nickname:null}));assert.equal(t.current(),'운영자가 정한 별명');assert.equal(t.writes.length,1);assert.equal(t.store.value(),null);
});
test('a lost PATCH response retains the journal and recovers ownership without overwriting the restoration source',async()=>{
  let lose=true;const t=transport({current:null,afterPatch:async()=>{if(lose)throw new Error('sensitive REST timeout');}});
  await assert.rejects(t.client.applyNickname(job()),e=>e.code==='retry');assert.equal(t.store.value().phase,'pending');assert.equal(t.store.value().originalNickname,null);
  lose=false;await t.client.applyNickname(job());assert.equal(t.writes.length,1);assert.equal(t.store.value().phase,'managed');
  await t.client.applyNickname(job({nickname:null}));assert.equal(t.current(),null);assert.equal(t.store.value(),null);
});
test('owner and equal or higher roles are member-specific restrictions while role jobs still apply',async()=>{
  for(const options of [{ownerId:user},{targetRoles:[otherRole]}]){
    const t=transport(options);await assert.rejects(t.client.applyNickname(job()),e=>e.code==='not_manageable');assert.equal(t.store.value(),null);assert.equal(t.writes.length,0);
    await t.client.apply({...job(),roleId:config.roleId,desired:true});assert.equal(t.writes.at(-1)[0],'PUT');
  }
});
test('missing nickname permission, corrupt state and foreign scopes prevent nickname writes without changing roles',async()=>{
  const denied=transport({nicknamePermission:false});await assert.rejects(denied.client.applyNickname(job()),e=>e.code==='configuration_error');assert.equal(denied.writes.length,0);
  const invalid=transport({store:{get:async()=>{throw Error('private content');}}});await assert.rejects(invalid.client.applyNickname(job()),e=>e.code==='configuration_error');assert.equal(invalid.reads.length,0);
  for(const changes of [{guildId:owner},{authorization:{...authorization,guildId:owner}},{authorization:{...authorization,nicknameEnabled:false}},{nickname:'x'.repeat(33)}])await assert.rejects(denied.client.applyNickname(job(changes)));assert.equal(denied.writes.length,0);
});
test('disabled nickname sync still releases only a nickname owned by this bot',async()=>{
  const t=transport();await t.client.applyNickname(job());await t.client.applyNickname(job({nickname:null,authorization:{...authorization,nicknameEnabled:false}}));assert.equal(t.current(),'원래 별명');assert.equal(t.store.value(),null);
});
test('expiry before PATCH and a definite Discord rejection do not leave false ownership records',async()=>{
  let now=Date.now();const base=now;const t=transport({clock:()=>now,onGet:()=>{now+=14500;}});
  await assert.rejects(t.client.applyNickname(job({expiresAt:new Date(base+60000).toISOString()})),e=>e.code==='retry');assert.equal(t.writes.length,0);assert.equal(t.store.value(),null);
  const rejected=transport();rejected.rest.patch=async()=>{throw{status:403,code:50013};};await assert.rejects(rejected.client.applyNickname(job()),e=>e.code==='configuration_error');assert.equal(rejected.store.value(),null);
});
test('independent workers preserve role progress and health when a nickname cannot be managed',async()=>{
  const acks=[];const api={claim:async()=>[{...job(),roleId:config.roleId,desired:true}],ack:async(_j,outcome)=>acks.push(['role',outcome]),claimNicknames:async()=>[job()],ackNickname:async(_j,outcome)=>acks.push(['nickname',outcome])};
  const transport={apply:async()=>{},applyNickname:async()=>{throw{code:'not_manageable'};}};
  const role=new RoleWorker(api,transport,config,{log:()=>{}}),nick=new NicknameWorker(api,transport,config,{log:()=>{}});
  await Promise.all([nick.tick(),role.tick()]);assert.deepEqual(acks.sort(),[['nickname','not_manageable'],['role','applied']]);assert.equal(role.isHealthy(),true);assert.equal(nick.isHealthy(),true);
  api.claimNicknames=async()=>{throw Error('private error');};await Promise.all([nick.tick(),role.tick()]);assert.equal(role.isHealthy(),true);assert.equal(nick.isHealthy(),false);assert.equal(acks.filter(([type])=>type==='role').length,2);
});
test('nickname stale acknowledgements and expired replies never clear a configuration failure or report success',async()=>{
  let broken=true,stale=false,now=Date.now(),expire=false,acks=0;const expiresAt=new Date(now+60000).toISOString();
  const worker=new NicknameWorker({claimNicknames:async()=>[job({expiresAt})],ackNickname:async()=>{acks++;if(stale)throw{status:409};}},
    {applyNickname:async()=>{if(expire)now+=60001;if(broken)throw{code:'configuration_error'};}},config,{clock:()=>now,log:()=>{}});
  await worker.tick();assert.equal(worker.isHealthy(),false);broken=false;stale=true;await worker.tick();assert.equal(worker.isHealthy(),false);
  stale=false;expire=true;await worker.tick();assert.equal(acks,2);assert.equal(worker.isHealthy(),false);
});
test('private nickname state survives restart, rejects wrong guild/corrupt data and deletes released records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'passport-nicknames-test-')),file=join(dir,'nicknames.json');
  try{const store=new NicknameStore(file,config);assert.equal(await store.get(user),null);const record={originalNickname:'원래 이름',managedNickname:'가상 회원 / Synthetic',phase:'pending'};await store.set(user,record);assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await new NicknameStore(file,config).get(user),record);await assert.rejects(new NicknameStore(file,{guildId:owner}).get(user));
    await store.set(user,null);assert.equal(await store.get(user),null);assert.ok(!(await readFile(file,'utf8')).includes('원래 이름'));
    await writeFile(file,'{"records":{"private":"secret"}}');await assert.rejects(store.get(user),e=>e.message==='nickname_state_invalid'&&!e.message.includes('secret'));
  }finally{await rm(dir,{recursive:true});}
});
