import test from 'node:test';
import assert from 'node:assert/strict';
import {PagedConnection, retryDelay} from '../dist/paged-connection.js';

class Socket {
    static OPEN=1; static instances=[];readyState=0;sent=[];
    constructor(){Socket.instances.push(this);}
    open(){this.readyState=1;this.onopen();}
    receive(value){this.onmessage({data:JSON.stringify(value)});}
    send(text){this.sent.push(JSON.parse(text));}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
}
const page=id=>({id,title:id,width:1200,height:1600,background:null,strokes:[],nextOrder:0});
const structure=()=>({type:'structure',notebook:{id:'book',title:'Course',topics:[{id:'topic',title:'Slides',pages:[page('one'),page('two')]}]},position:{pageId:'one',y:0}});
function setup(){
    const timers=new Map();let id=0;globalThis.window={setTimeout(callback,delay){timers.set(++id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);}};
    Socket.instances=[];globalThis.WebSocket=Socket;const received=[],pages=[],states=[];
    const connection=new PagedConnection(new URL('ws://localhost/ws/notebook/v2/view/test'),value=>{received.push(value);if(value.type==='notebook')connection.select('one');},page=>pages.push(page),state=>states.push(state),()=>{});
    connection.start();Socket.instances[0].open();Socket.instances[0].receive(structure());
    return{connection,received,pages,states,timers,socket:()=>Socket.instances.at(-1)};
}

test('structure loads no ink; navigation subscribes only to the chosen page and discards late results',()=>{
    const env=setup();assert.deepEqual(env.socket().sent,[{type:'subscribe',pageId:'one',request:1}]);
    env.connection.select('two');env.socket().receive({type:'page',page:page('one'),request:1,revision:'a'});assert.equal(env.pages.length,0);
    env.socket().receive({type:'page',page:page('two'),request:2,revision:'b'});assert.equal(env.pages.at(-1).id,'two');
    env.socket().receive({type:'edit',edit:{id:'offpage',pageId:'one',insert:[],remove:[],height:1600}});assert.equal(env.received.length,1);
    env.connection.stop();assert.equal(env.timers.size,0);
});

test('cached pages are reused only after revision validation and invalidated by later edits',()=>{
    const env=setup();env.socket().receive({type:'page',page:page('one'),request:1,revision:'a'});
    env.connection.select('two');env.socket().receive({type:'page',page:page('two'),request:2,revision:'b'});
    env.connection.select('one');assert.equal(env.socket().sent.at(-1).revision,'a');
    env.socket().receive({type:'page_current',pageId:'one',request:3,revision:'a'});assert.equal(env.pages.length,3);
    env.socket().receive({type:'revision',pageId:'one',revision:'c'});
    env.connection.select('two');env.connection.select('one');assert.equal(env.socket().sent.at(-1).revision,'c');env.connection.stop();
});

test('reconnect keeps cache but validates the selected page again',()=>{
    const env=setup();env.socket().receive({type:'page',page:page('one'),request:1,revision:'a'});env.socket().close(1006);
    const timer=[...env.timers].find(([,value])=>value.delay>=250&&value.delay<=500);env.timers.delete(timer[0]);timer[1].callback();
    env.socket().open();env.socket().receive(structure());assert.equal(env.socket().sent.at(-1).revision,'a');assert.equal(env.socket().sent.at(-1).request,2);env.connection.stop();
});

test('rate-limited or busy readers retry later; only server rejections are permanent',()=>{
    const env=setup();env.socket().close(1013);
    const retry=[...env.timers.values()].find(value=>value.delay>=2000);assert.ok(retry,'1013 schedules a delayed reconnect');
    assert.equal(env.states.at(-1),'disconnected');
    retry.callback();env.socket().open();env.socket().receive(structure());env.socket().close(1008);
    assert.equal(env.states.at(-1),'error');env.connection.stop();
});

test('invalid local data reconnects a few times before giving up',()=>{
    const env=setup();
    for(let attempt=0;attempt<2;attempt++){
        env.socket().receive({type:'page',page:{broken:true},request:env.socket().sent.at(-1).request,revision:'a'});
        assert.equal(env.states.at(-1),'disconnected');
        const retry=[...env.timers.entries()].find(([,value])=>value.delay<=5000&&value.delay>=250);env.timers.delete(retry[0]);retry[1].callback();
        env.socket().open();env.socket().receive(structure());
    }
    env.socket().receive({type:'page',page:{broken:true},request:env.socket().sent.at(-1).request,revision:'a'});
    assert.equal(env.states.at(-1),'error');env.connection.stop();
});

test('rapid page changes are coalesced to the latest selection',()=>{
    const env=setup();
    for(let index=0;index<12;index++)env.connection.select(index%2?'one':'two');
    const sent=env.socket().sent.filter(value=>value.type==='subscribe');
    assert.ok(sent.length<=6,`at most the burst is sent immediately (${sent.length})`);
    const pending=[...env.timers.values()].find(value=>value.delay>0&&value.delay<1000);assert.ok(pending);
    pending.callback();const last=env.socket().sent.at(-1);assert.equal(last.pageId,'one');assert.equal(last.request,13);env.connection.stop();
});

test('retry delays are jittered, bounded and longer after a busy server',()=>{
    assert.equal(retryDelay(0,1006,()=>0),250);assert.equal(retryDelay(0,1006,()=>1),500);
    assert.equal(retryDelay(10,1006,()=>1),5000);assert.equal(retryDelay(0,1013,()=>0),2000);
});
