import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ButtonStyle } from 'discord.js';
import { InteractionHandler, LINK_BUTTON } from '../src/interactions.js';
import { DiscordPanel } from '../src/panel.js';
import { PanelStore } from '../src/panel-store.js';
import { command, registerCommands } from '../src/commands.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config={applicationId:'100000000000000001',guildId:'100000000000000002',roleId:'100000000000000003',channelId:'100000000000000004'};
const bot='100000000000000006';
function interaction(kind='link',changes={}) {
  const messages=[];return{messages,id:'100000000000000008',guildId:config.guildId,channelId:config.channelId,user:{id:'100000000000000005',username:'Synthetic',bot:false},client:{user:{id:bot}},message:{author:{id:bot}},memberPermissions:{has:()=>true},
    isButton:()=>kind==='link',isChatInputCommand:()=>kind==='setup',commandName:'passport',options:{getSubcommand:()=> 'setup'},customId:LINK_BUTTON,
    reply:async function(body){messages.push(['reply',body]);this.replied=true;},deferReply:async function(body){messages.push(['defer',body]);this.deferred=true;},editReply:async body=>messages.push(['edit',body]),...changes};
}
test('button defers ephemerally before API work and uses only authenticated interaction actor',async()=>{
  const i=interaction();let input;const url='https://portal.example/discord/link/test#token=synthetic';
  const handler=new InteractionHandler(config,{createLink:async body=>{assert.equal(i.messages[0][0],'defer');assert.equal(i.messages[0][1].flags,MessageFlags.Ephemeral);input=body;return{url};}},{});
  await handler.handle(i);assert.deepEqual(input,{discordUserId:i.user.id,guildId:config.guildId,discordUsername:'Synthetic',interactionId:i.id});
  const response=i.messages[1][1];assert.deepEqual(response.allowedMentions,{parse:[]});assert.equal(response.components[0].components[0].style,ButtonStyle.Link);assert.equal(response.components[0].components[0].url,url);
  assert.ok(!JSON.stringify(i.messages[0]).includes(url));assert.equal(i.messages.filter(([method])=>method==='reply').length,0);
});
test('wrong guild/channel, bot callers and foreign message authors never create links',async()=>{
  const handler=new InteractionHandler(config,{createLink:async()=>assert.fail('not authorized')},{});
  for(const changes of [{guildId:'100000000000000099'},{channelId:'100000000000000099'},{user:{id:'100000000000000005',username:'Synthetic',bot:true}},{message:{author:{id:'100000000000000099'}}}]){
    const i=interaction('link',changes);await handler.handle(i);assert.equal(i.messages[0][1].flags,MessageFlags.Ephemeral);
  }
});
test('setup requires Manage Guild in the configured channel and never posts at startup',async()=>{
  let published=0;const handler=new InteractionHandler(config,{}, {publish:async()=>published++});assert.equal(published,0);
  for(const changes of [{memberPermissions:{has:()=>false}},{channelId:'100000000000000099'},{guildId:null}])await handler.handle(interaction('setup',changes));assert.equal(published,0);
  const i=interaction('setup');await handler.handle(i);assert.equal(published,1);assert.equal(i.messages[0][1].flags,MessageFlags.Ephemeral);assert.equal(command.default_member_permissions,PermissionFlagsBits.ManageGuild.toString());
});
test('overlapping setup and repeated buttons are bounded; raw errors never enter replies or logs',async()=>{
  let resolve,count=0;const logs=[];const handler=new InteractionHandler(config,{createLink:async()=>{count++;throw new Error('secret user token');}},{publish:()=>new Promise(r=>{resolve=r;})},{log:code=>logs.push(code)});
  const first=handler.handle(interaction('setup'));await Promise.resolve();await handler.handle(interaction('setup'));resolve();await first;
  const one=interaction();await handler.handle(one);await handler.handle(interaction());assert.equal(count,1);assert.ok(!JSON.stringify(one.messages).includes('secret user token'));assert.deepEqual(logs,['interaction_failed']);
});
test('command registration updates only the single guild command instead of overwriting other commands',async()=>{
  const calls=[];await registerCommands({post:async(...args)=>calls.push(args)},config);assert.equal(calls.length,1);assert.ok(calls[0][0].includes(`/guilds/${config.guildId}/commands`));assert.equal(calls[0][1].body.name,'passport');
});
test('setup persists one panel and edits it later, refusing foreign message authors and channel types',async()=>{
  let sends=0,edits=0,stored=null;const message={id:'100000000000000009',author:{id:bot},edit:async()=>edits++};
  const channel={type:0,guildId:config.guildId,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>message},send:async body=>{sends++;assert.deepEqual(body.allowedMentions,{parse:[]});return message;}};
  const panel=new DiscordPanel({user:{id:bot},channels:{fetch:async()=>channel}},config,{get:async()=>stored,set:async id=>{stored=id;}});
  await panel.publish();await panel.publish();assert.equal(sends,1);assert.equal(edits,1);
  message.author.id='100000000000000099';await assert.rejects(panel.publish());assert.equal(sends,1);channel.type=1;await assert.rejects(panel.publish());
});
test('durable panel state is scoped to configured guild/channel and contains no user or token data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'passport-panel-test-'));const file=join(dir,'panel.json');
  try {const store=new PanelStore(file,config);assert.equal(await store.get(),null);await store.set('100000000000000009');assert.equal(await store.get(),'100000000000000009');assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(Object.keys(JSON.parse(await readFile(file,'utf8'))).sort(),['channelId','guildId','messageId']);await assert.rejects(new PanelStore(file,{...config,channelId:'100000000000000099'}).get());}
  finally {await rm(dir,{recursive:true});}
});
