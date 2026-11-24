import test from 'node:test';
import assert from 'node:assert/strict';
import { publisherServer } from '../.test-build/publisher-access.js';
import { DeltaPublisher } from '../.test-build/delta-publisher.js';

const KEY='d'.repeat(64), SECRET='7'.repeat(64), HEAD='a'.repeat(64);
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const snapshot=()=>({type:'notebook',notebook:{id:'book',title:'Private lecture',topics:[{id:'topic',title:'Notes',pages:[{id:'page',title:'Page',width:1200,height:1600,background:null,strokes:[],nextOrder:0}]}]},position:{pageId:'page',y:0}});
class Socket {
    static OPEN=1;static instances=[];readyState=0;bufferedAmount=0;sent=[];
    constructor(url){this.url=String(url);Socket.instances.push(this);}
    open(){this.readyState=1;this.onopen();}
    send(text){this.sent.push(JSON.parse(text));}
    receive(message){this.onmessage({data:JSON.stringify(message)});}
    close(code=1000){this.readyState=3;this.onclose?.({code,reason:''});}
}
function setup(){
    globalThis.WebSocket=Socket;Socket.instances=[];
    const timers=new Map();let id=0;
    globalThis.window={setTimeout(callback,delay){timers.set(++id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);}};
    const state=snapshot(),states=[];
    const publisher=new DeltaPublisher(()=>state,SECRET,async()=>new Uint8Array(),value=>states.push(value),{
        status:async()=>({sequence:0,head:HEAD,firstPending:null}),
        checkpoint:async()=>({sequence:0,head:HEAD,notebook:state.notebook}),
        outgoing:async()=>[],acknowledge:async()=>{},preview:()=>state,
    });
    return {publisher,state,states,timers,socket:()=>Socket.instances.at(-1)};
}

test('credentials never enter a URL and notebook data waits for authentication acknowledgement',async()=>{
    const env=setup();env.publisher.start('https://notes.example',KEY);await turn();env.socket().open();
    assert.equal(env.socket().url,'wss://notes.example/ws/sync/v2/publish');
    assert.deepEqual(env.socket().sent,[{type:'authenticate',key:KEY}]);
    env.publisher.publish({type:'viewport',position:{pageId:'page',y:0}});assert.equal(env.socket().sent.length,1);
    env.socket().receive({type:'authenticated'});await turn();
    assert.equal(env.socket().sent[1].type,'hello');assert.equal(env.socket().sent[1].secret,SECRET);
    assert.ok(!JSON.stringify(env.socket().sent[1]).includes(KEY));env.publisher.stop();await turn();
});

test('missing and invalid server credentials cannot initiate network connections',()=>{
    const env=setup();
    for (const key of ['',SECRET.slice(1),'password']) assert.throws(()=>env.publisher.start('https://notes.example',key));
    assert.equal(Socket.instances.length,0);
    for (const server of ['http://notes.example','http://127.0.0.1.evil.example','https://user:secret@notes.example','https://notes.example/?key=abc'])
        assert.throws(()=>env.publisher.start(server,KEY));
    assert.equal(Socket.instances.length,0);
    for (const server of ['https://notes.example','http://localhost:8000','http://127.0.0.1:8000','http://[::1]:8000']) assert.ok(publisherServer(server));
});

test('authentication refusal stops retrying without losing local documents',async()=>{
    for (const code of [4401,4426,4503]) {
        const env=setup();env.publisher.start('https://notes.example',KEY);await turn();env.socket().open();env.socket().close(code);await turn();
        assert.equal(env.states.at(-1).phase,'error');assert.equal(env.timers.size,0);assert.deepEqual(env.state,snapshot());env.publisher.stop();
    }
});

test('PDF uploads carry both capabilities, reject redirects and stop on rejected credentials',async t=>{
    const env=setup();let request;
    env.state.notebook.topics[0].pages[0].background={assetId:'a'.repeat(64),name:'slide.pdf',pageNumber:1,width:960,height:540};
    t.mock.method(globalThis,'fetch',async(url,options)=>{request={url:String(url),options};return {ok:false,status:401};});
    env.publisher.start('https://notes.example',KEY);await turn();env.socket().open();env.socket().receive({type:'authenticated'});await turn();
    env.socket().receive({type:'resume',sequence:0,sessionId:'f'.repeat(64),recover:true,assets:[]});await turn();
    assert.equal(request.options.headers['X-LiveMitschrift-Publisher-Key'],KEY);
    assert.equal(request.options.headers.Authorization,`Bearer ${SECRET}`);assert.equal(request.options.redirect,'error');
    assert.ok(!request.url.includes(KEY));assert.equal(env.states.at(-1).phase,'error');assert.equal(env.timers.size,0);env.publisher.stop();
});

test('server withdrawal uses the read identity, the personal key and explains refusals', async () => {
    const { notebookIdentity, withdrawFromServer } = await import('../.test-build/publisher-access.js');
    const { createHash } = await import('node:crypto');
    assert.equal(await notebookIdentity(SECRET), createHash('sha256').update(SECRET).digest('hex'));
    const calls = [];
    const respond = status => { globalThis.fetch = async (url, init) => { calls.push({url: String(url), init}); return {status}; }; };
    respond(204); await withdrawFromServer('https://notes.example.org', KEY, SECRET);
    assert.equal(calls[0].url, `https://notes.example.org/api/notebook/${await notebookIdentity(SECRET)}`);
    assert.equal(calls[0].init.method, 'DELETE'); assert.equal(calls[0].init.headers['X-LiveMitschrift-Publisher-Key'], KEY);
    respond(404); await withdrawFromServer('https://notes.example.org', KEY, SECRET);
    respond(403); await assert.rejects(withdrawFromServer('https://notes.example.org', KEY, SECRET), /anderen Person/);
    respond(500); await assert.rejects(withdrawFromServer('https://notes.example.org', KEY, SECRET), /500/);
    await assert.rejects(withdrawFromServer('http://notes.example.org', KEY, SECRET), /HTTPS/);
});
