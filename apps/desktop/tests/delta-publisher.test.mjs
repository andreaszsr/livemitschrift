import test from 'node:test';
import assert from 'node:assert/strict';
import {DeltaPublisher} from '../.test-build/delta-publisher.js';
import {SyncTransfer} from '@livemitschrift/core';

class Socket {
    static OPEN=1; static instances=[]; readyState=0; bufferedAmount=0; sent=[]; transfer=new SyncTransfer();
    constructor(url){this.url=String(url);Socket.instances.push(this);}
    open(){this.readyState=1;this.onopen();this.receive({type:'authenticated'});}
    send(text){const value=this.transfer.receive(text);if(value)this.sent.push(value);}
    receive(value){this.onmessage({data:JSON.stringify(value)});}
    close(code=1000){this.readyState=3;this.onclose?.({code,reason:''});}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const page=id=>({id,title:id,width:1200,height:1600,background:null,strokes:[],nextOrder:0});
function setup(){
    const timers=new Map();let timerId=0;globalThis.window={setTimeout(callback,delay){timers.set(++timerId,{callback,delay});return timerId;},clearTimeout(id){timers.delete(id);}};
    globalThis.WebSocket=Socket;Socket.instances=[];
    const state={type:'notebook',notebook:{id:'book',title:'Course',topics:[{id:'topic',title:'Slides',pages:[page('one'),page('two')]}]},position:{pageId:'one',y:0}};
    const pending=[],acks=[],states=[];let checkpoints=0,sequence=4;
    const publisher=new DeltaPublisher(()=>state,'1'.repeat(64),async()=>new Uint8Array([37,80,68,70,45]),value=>states.push(value),{
        status:async()=>({sequence,head:'a'.repeat(64),firstPending:pending[0]?.sequence??null}),
        checkpoint:async()=>{checkpoints++;return{sequence,head:'a'.repeat(64),notebook:structuredClone(state.notebook)};},
        outgoing:async after=>pending.filter(value=>value.sequence>after).slice(0,1),
        acknowledge:async sequence=>{acks.push(sequence);while(pending[0]?.sequence<=sequence)pending.shift();},
        preview:()=>state,
    });
    return{publisher,state,pending,acks,states,timers,socket:()=>Socket.instances.at(-1),checkpoints:()=>checkpoints,sequence:value=>sequence=value};
}
async function connect(env,resume={sequence:4,recover:false,assets:[]}){
    env.publisher.start('https://example.test','d'.repeat(64));await turn();env.socket().open();await turn();
    assert.equal(env.socket().sent.at(-1).type,'hello');env.socket().receive({type:'resume',sessionId:'f'.repeat(64),...resume});await turn();
}

test('unchanged reconnect reads only status, sends no notebook, page, or PDF',async()=>{
    const env=setup();await connect(env);
    assert.equal(env.checkpoints(),0);assert.deepEqual(env.acks,[4]);
    assert.deepEqual(env.socket().sent.map(value=>value.type),['authenticate','hello','extent','viewport']);
    assert.equal(env.states.at(-1).phase,'live');env.publisher.stop();assert.equal(env.timers.size,0);
});

test('offline commits replay from the server revision and only ACKed entries leave the outbox',async()=>{
    const env=setup();env.pending.push({sequence:4,head:'a'.repeat(64),change:{type:'edit',edit:{id:'offline'}}});
    await connect(env,{sequence:3,recover:false,assets:[]});
    assert.equal(env.checkpoints(),0);assert.equal(env.socket().sent.at(-1).type,'commit');assert.equal(env.pending.length,1);
    env.socket().receive({type:'ack',sequence:4});await turn();assert.equal(env.pending.length,0);assert.deepEqual(env.acks,[3,4]);env.publisher.stop();
});

test('first publication stages each page before an atomic checkpoint ACK; later edits are retained',async()=>{
    const env=setup();await connect(env,{sequence:0,recover:true,assets:[]});
    assert.equal(env.checkpoints(),1);assert.equal(env.socket().sent.at(-1).page.id,'one');assert.deepEqual(env.acks,[]);
    env.pending.push({sequence:5,head:'b'.repeat(64),change:{type:'edit',edit:{id:'during-upload'}}});env.sequence(5);
    env.socket().receive({type:'page_staged',pageId:'one'});await turn();assert.equal(env.socket().sent.at(-1).page.id,'two');
    env.socket().receive({type:'page_staged',pageId:'two'});await turn();assert.equal(env.socket().sent.at(-1).type,'recover_end');
    env.socket().receive({type:'ack',sequence:4});await turn();assert.deepEqual(env.acks,[4]);assert.equal(env.socket().sent.at(-1).sequence,5);
    env.socket().receive({type:'ack',sequence:5});await turn();assert.equal(env.pending.length,0);env.publisher.stop();
});

test('known PDF resources are skipped for structural operations',async()=>{
    const env=setup(),asset='c'.repeat(64);env.state.notebook.topics[0].pages[0].background={assetId:asset,name:'slides.pdf',pageNumber:1,width:800,height:600};
    globalThis.fetch=()=>{throw Error('Existing asset was uploaded again');};
    await connect(env,{sequence:4,recover:false,assets:[asset]});
    env.pending.push({sequence:5,head:'b'.repeat(64),change:{type:'structure',notebook:env.state.notebook}});env.publisher.changed();await turn();
    assert.equal(env.socket().sent.at(-1).type,'commit');assert.equal(env.socket().sent.at(-1).change.type,'structure');
    env.socket().receive({type:'ack',sequence:5});await turn();assert.equal(env.checkpoints(),0);env.publisher.stop();
});

test('lost acknowledgement cannot be hidden by heartbeats and stop cancels outstanding requests',async()=>{
    const env=setup();await connect(env);env.pending.push({sequence:5,head:'b'.repeat(64),change:{type:'edit'}});env.publisher.changed();await turn();
    env.socket().receive({type:'pong'});const timer=[...env.timers].find(([,value])=>value.delay===30000);assert.ok(timer);env.timers.delete(timer[0]);timer[1].callback();await turn();
    assert.equal(env.states.at(-1).phase,'reconnecting');assert.equal(env.pending.length,1);env.publisher.stop();await turn();assert.equal(env.timers.size,0);
});

test('new-page input waits for structural ACK and resumes the active stroke with its actual geometry',async()=>{
    const env=setup();await connect(env);
    env.state.notebook.topics[0].pages.push(page('new-page'));env.state.position.pageId='new-page';
    env.pending.push({sequence:5,head:'b'.repeat(64),change:{type:'structure',notebook:structuredClone(env.state.notebook)}});
    env.publisher.refresh();await turn();
    const socket=env.socket(),count=socket.sent.length;
    const stroke={id:'new-ink',order:0,color:'#243147',width:3.5,complete:false,points:[{x:50,y:1700,pressure:.2},{x:100,y:1750,pressure:.6}]};
    env.state.notebook.topics[0].pages.at(-1).height=2400;env.state.notebook.topics[0].pages.at(-1).strokes=[stroke];
    env.publisher.publish({type:'ink',pageId:'new-page',operation:{type:'stroke_start',stroke}});await turn();assert.equal(socket.sent.length,count);
    socket.receive({type:'ack',sequence:5});await turn();
    const resumed=socket.sent.find(value=>value.type==='resume_ink');assert.deepEqual(resumed.stroke,stroke);
    const extent=socket.sent.findLast(value=>value.type==='extent');assert.equal(extent.pageId,'new-page');assert.equal(extent.height,2400);
    env.publisher.publish({type:'ink',pageId:'new-page',operation:{type:'stroke_end',stroke_id:'new-ink'}});await turn();assert.equal(socket.sent.at(-1).operation.type,'stroke_end');env.publisher.stop();
});
