import test from 'node:test';
import assert from 'node:assert/strict';
import {syncFrames, SyncTransfer, MAX_SYNC_FRAME_BYTES} from '../dist/index.js';

test('large and Unicode values round trip through bounded synchronization frames',()=>{
    const value={type:'test',text:'ä😀漢'.repeat(100000)}, transfer=new SyncTransfer();let result;
    for(const frame of syncFrames(value)){assert.ok(new TextEncoder().encode(frame).length<=MAX_SYNC_FRAME_BYTES);result=transfer.receive(frame)??result;}
    assert.deepEqual(result,value);
});

test('partial, nested and interrupted transfers cannot be applied as protocol objects',()=>{
    const transfer=new SyncTransfer();assert.equal(transfer.receive('{"type":"transfer_start"}'),null);
    assert.throws(()=>transfer.receive('{"type":"transfer_start"}'));
    assert.throws(()=>transfer.receive('{"type":"edit"}'));
    assert.throws(()=>new SyncTransfer().receive('{"type":"transfer_end"}'));
});
