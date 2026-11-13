import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCloudServer } from '../src/cloud-server.mjs';
import { startLocalAgent } from '../src/local-agent.mjs';
import { generateTotpCode, signE2EPayload } from '../src/crypto-auth.mjs';
import { acceptWebSocketUpgrade } from '../src/ws-minimal.mjs';
import { connectHttpPollClient } from '../src/relay-transport.mjs';

async function until(check, timeout=7000) { const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Polling fixture timeout'); }
async function fixture() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'http-poll-test-'));
 const cloud=createCloudServer({host:'127.0.0.1',port:0,dataDir:dir,quiet:true,pollTransportOptions:{pollTimeoutMs:80,idleTimeoutMs:1000},env:{CODEX_ADMIN_PASSWORD:'fixture-password',CODEX_TOTP_SECRET:'JBSWY3DPEHPK3PXP'}});
 const port=await cloud.listen(),base=`http://127.0.0.1:${port}`;
 const login=async()=>{
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-password',totpCode:generateTotpCode('JBSWY3DPEHPK3PXP')})});
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
 };
 const cookie=await login(),headers={Cookie:cookie,Origin:base};
 const request=(route,body,extra={})=>fetch(base+route,{method:body===undefined?'GET':'POST',...extra,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'}),...extra.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {cloud,dir,port,base,cookie,headers,request,login,async close(){await cloud.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('HTTP polling authenticates and binds sessions, replays unacknowledged events and deduplicates sends',async()=>{
 const f=await fixture();
 try {
  assert.equal((await f.request('/api/socket/open',{path:'/ws/client'},{headers:{Cookie:''}})).status,401);
  assert.equal((await f.request('/api/socket/open',{path:'/ws/client'},{headers:{Origin:'https://evil.test'}})).status,403);
  for(const target of ['https://evil.test/ws/client','//evil.test/ws/client','/api/auth/logout','/ws/client#fragment'])assert.equal((await f.request('/api/socket/open',{path:target})).status,400);
  const open=await f.request('/api/socket/open',{path:'/ws/client'});assert.equal(open.status,200);
  const peer=await open.json(),headers={'X-Codex-Poll-Token':peer.token};
  const route='/api/socket/'+peer.id;
  assert.equal((await f.request(route+'/send',null,{headers})).status,400);
  assert.equal((await f.request(route+'/send',{seq:1,binary:true,data:'not base64!'},{headers})).status,400);
  assert.equal((await f.request(route+'/events')).status,404);
  const first=await (await f.request(route+'/events?cursor=0',undefined,{headers})).json();
  assert.equal(JSON.parse(first.events[0].data).type,'relay/welcome');
  assert.deepEqual(await (await f.request(route+'/events?cursor=0',undefined,{headers})).json(),first,'lost poll replies are replayed until acknowledged');
  const body={seq:1,data:JSON.stringify({type:'client/ping'}),binary:false};
  assert.equal((await f.request(route+'/send',body,{headers})).status,200);
  assert.equal((await f.request(route+'/send',body,{headers})).status,200);
  const pong=await (await f.request(route+'/events?cursor='+first.cursor,undefined,{headers})).json();
  assert.equal(pong.events.length,1);assert.equal(JSON.parse(pong.events[0].data).type,'relay/pong');
  const empty=await(await f.request(route+'/events?cursor='+pong.cursor,undefined,{headers})).json();assert.equal(empty.events.length,0);
  const pending=f.request(route+'/events?cursor='+pong.cursor,undefined,{headers});await new Promise(r=>setTimeout(r,10));
  assert.equal((await f.request(route+'/events?cursor='+pong.cursor,undefined,{headers})).status,409);await pending;
  const secondCookie=await f.login();
  assert.equal((await f.request(route+'/events?cursor='+pong.cursor,undefined,{headers:{...headers,Cookie:secondCookie}})).status,401);
  await until(()=>f.cloud.clients.size===0);
 }finally{await f.close();}
});

test('Agent auto-fallback and poll-only browser preserve signed Codex RPC, native binary WebSockets and logout/revocation',async()=>{
 const f=await fixture();let agent,client,native;const rawSockets=new Set();let count=0;
 const upstream=http.createServer((_req,res)=>res.end('fixture'));
 upstream.on('connection',socket=>{rawSockets.add(socket);socket.on('close',()=>rawSockets.delete(socket));});
 upstream.on('upgrade',(req,socket,head)=>{
  if(req.headers.authorization!=='Bearer injected'){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
  const ws=acceptWebSocketUpgrade(req,socket,head);ws.on('message',raw=>{count++;ws._writeFrame(Buffer.isBuffer(raw)?2:1,Buffer.from(raw));});
 });
 try {
  const upgrade=f.cloud.server.listeners('upgrade')[0];f.cloud.server.removeListener('upgrade',upgrade);
  f.cloud.server.on('upgrade',(req,socket,head)=>{
   if(socket instanceof net.Socket){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   upgrade(req,socket,head);
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const port=upstream.address().port;
  agent=startLocalAgent({relayUrl:f.base.replace('http:','ws:')+'/ws/agent',relayTransport:'auto',codexHome:path.join(f.dir,'agent'),defaultCwd:f.dir,
   codexBin:fileURLToPath(new URL('./fixtures/fake-codex.mjs',import.meta.url)),quiet:true,webServices:[{id:'fixture',name:'Fixture',port,auth:{headers:{Authorization:'Bearer injected'}}}]});
  await until(()=>f.cloud.agents.get(agent.identity.agentId)?.webServices?.[0].status==='ready');
  await f.request('/api/agents/trust',{agentId:agent.identity.agentId,trusted:true});
  client=await connectHttpPollClient(f.base.replace('http:','ws:')+'/ws/client',{headers:f.headers});
  const messages=[];client.on('message',raw=>messages.push(JSON.parse(raw)));
  await until(()=>messages.some(m=>m.type==='relay/welcome'));
  function rpc(id,method,params,valid=true){
   const payload={id,method,params},timestamp=Date.now(),nonce='poll_'+id;
   const signature=signE2EPayload(agent.identity.localSigningKey,{timestamp,nonce,bodyString:JSON.stringify(payload)});
   client.send({type:'client/rpc',agentId:agent.identity.agentId,payload,e2e:valid?{timestamp,nonce,signature}:null});
  }
  rpc('unsigned','thread/start',{cwd:f.dir},false);await until(()=>messages.some(m=>m.type==='relay/e2e_error'));
  rpc('signed','thread/start',{cwd:f.dir});await until(()=>messages.some(m=>m.payload?.id==='signed'));
  const thread=messages.find(m=>m.payload?.id==='signed').payload.result.thread;assert.ok(thread.id.startsWith('new-'));
  native=await connectHttpPollClient(f.base.replace('http:','ws:')+`/local/${agent.identity.agentId}/${port}/echo`,{headers:f.headers});
  const bytes=Buffer.alloc(200000,241),response=new Promise(r=>native.once('message',r));native._writeFrame(2,bytes);assert.deepEqual(await response,bytes);assert.equal(count,1);
  const closed=new Promise(r=>native.once('close',r));await f.request('/api/agents/trust',{agentId:agent.identity.agentId,trusted:false});await closed;
  const logoutClosed=new Promise(r=>client.once('close',r));await f.request('/api/auth/logout',{});await logoutClosed;
  assert.equal(agent.connected,true,'browser logout does not disconnect the registered Agent');
  await agent.stop();await until(()=>!f.cloud.agents.has(agent.identity.agentId));
 }finally{native?.close();client?.close();agent?.stop();await f.close();rawSockets.forEach(s=>s.destroy());await new Promise(r=>upstream.close(r));}
});

test('browser-compatible socket automatically falls back and safely retries a lost send acknowledgement',async()=>{
 const f=await fixture();let socket;let dropped=false;
 class BlockedWebSocket { constructor(){setTimeout(()=>this.onerror?.(new Event('error')),0);}close(){} }
 try {
  const Socket=globalThis.CodexRelayTransport.createWebSocketClass({NativeWebSocket:BlockedWebSocket,location:new URL(f.base),
   fetch:async(address,options)=>{
    const response=await fetch(address,{...options,headers:{...f.headers,...options.headers}});
    if(address.endsWith('/send')&&!dropped){dropped=true;await response.text();throw new TypeError('Simulated lost acknowledgement');}
    return response;
   }});
  socket=new Socket(f.base.replace('http:','ws:')+'/ws/client');const messages=[];
  const external = new Socket('wss://external.test/events');assert.ok(external instanceof BlockedWebSocket);external.close();
  socket.onmessage=event=>messages.push(JSON.parse(event.data));
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onclose=()=>reject(new Error('socket failed to open'));});
  assert.equal(socket.transport,'poll');assert.equal(socket.readyState,Socket.OPEN);
  await until(()=>messages.some(m=>m.type==='relay/welcome'));
  socket.send(JSON.stringify({type:'client/ping'}));
  await until(()=>dropped&&socket.bufferedAmount===0);
  assert.equal(messages.filter(m=>m.type==='relay/pong').length,1);
  socket.onclose=null;socket.close();await until(()=>f.cloud.pollTransport.size===0);
 }finally{if(socket){socket.onclose=null;socket.close();}await f.close();}
});
