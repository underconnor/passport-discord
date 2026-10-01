import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassportApi } from '../src/api.js';
import { RoleWorker } from '../src/role-worker.js';
import { NicknameWorker } from '../src/nickname-worker.js';

test('36 members with three roles and one nickname drain within a minute and leave room for new revocations',async()=>{
  const start=Date.now();let now=start;
  const config={guildId:'100000000000000002',apiBase:'https://api.example.test/',apiToken:'synthetic'};
  const roleIds=['100000000000000003','100000000000000004','100000000000000005'];
  const authorization={contractVersion:2,guildId:config.guildId,settingsRevision:'1',managedRoleIds:roleIds,nicknameEnabled:true};
  const records={roles:[],nicknames:[]};let sequence=0;
  for(let member=0;member<36;member++) {
    const common={guildId:config.guildId,discordUserId:String(100000000000000100n+BigInt(member)),leaseToken:'t'.repeat(43),version:'1'};
    for(let role=0;role<3;role++)records.roles.push({...common,id:`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,roleId:roleIds[role],kind:['verification','member','semester'][role],semester:role===2?'26-2':null,desired:true,due:start,applied:[]});
    records.nicknames.push({...common,id:`10000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,nickname:'Example',due:start,applied:[]});
  }
  // A deterministic due-first API model. PostgreSQL queue fairness is covered in
  // the API repository; this exercises the real bot DTO limits and scheduling.
  const api=new PassportApi(config,async(url,options)=>{
    if(url.pathname.endsWith('/config'))return Response.json(authorization);
    const [, , ,stream,id,action]=url.pathname.split('/');
    if(id==='claim') {
      const {limit}=JSON.parse(options.body);
      const jobs=records[stream].filter(record=>record.due<=now).sort((a,b)=>a.due-b.due).slice(0,limit).map(record=>{
        record.due=now+60000;
        const {due,applied,...job}=record;return {...job,expiresAt:new Date(now+60000).toISOString()};
      });
      return Response.json({contractVersion:2,jobs});
    }
    assert.equal(action,'ack');const record=records[stream].find(item=>item.id===id);
    assert.equal(JSON.parse(options.body).outcome,'applied');record.applied.push(now);record.due=now+60000;
    return new Response(null,{status:204});
  },()=>now);
  const active={role:0,nickname:0},peak={role:0,nickname:0},revoked=[];
  const operation=kind=>async job=>{
    peak[kind]=Math.max(peak[kind],++active[kind]);
    // Synthetic asynchronous I/O; this is a capacity check, not a Discord SLA.
    await new Promise(resolve=>setTimeout(resolve,2));active[kind]--;
    if(kind==='role'&&!job.desired)revoked.push({id:job.id,at:now});
  };
  const roles=new RoleWorker(api,{apply:operation('role')},config,{clock:()=>now,log:()=>{}});
  const nicknames=new NicknameWorker(api,{applyNickname:operation('nickname')},config,{clock:()=>now,log:()=>{}});
  const revokedIds=records.roles.slice(0,3).map(record=>record.id),revokeAt=start+75000;
  for(let elapsed=0;elapsed<=180000;elapsed+=5000) {
    now=start+elapsed;
    if(now===revokeAt)for(const record of records.roles.slice(0,3)){record.desired=false;record.version='2';record.due=now;}
    await Promise.all([roles.tick(),nicknames.tick()]);
    assert.ok(roles.isHealthy());assert.ok(nicknames.isHealthy());
    if(elapsed===55000)for(const record of [...records.roles,...records.nicknames])assert.ok(record.applied.length>=1);
  }
  assert.deepEqual(peak,{role:2,nickname:1});
  for(const record of [...records.roles,...records.nicknames])assert.ok(record.applied.length>=3);
  for(const id of revokedIds){const first=revoked.find(record=>record.id===id);assert.ok(first);assert.ok(first.at-revokeAt<=15000);}
  // Normal 60-second reconciliation never accumulates a second overdue cycle.
  assert.ok(Math.max(...Object.values(records).flat().map(record=>now-record.applied.at(-1)))<=60000);
});
