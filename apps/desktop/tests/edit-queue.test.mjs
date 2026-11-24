import test from 'node:test';
import assert from 'node:assert/strict';
import { EditQueue } from '../.test-build/edit-queue.js';
const edit=(id,pageId='a')=>({id,pageId,height:6400,insert:[],remove:['stroke']});
test('failed deletes and edits on later pages stay ordered until acknowledged',async()=>{
  let fail=true;const attempts=[];const queue=new EditQueue(async value=>{attempts.push(structuredClone(value));if(fail)throw new Error('disk full');},()=>{});
  queue.enqueue(edit('one'));assert.equal(await queue.flush(),false);queue.enqueue(edit('two','b'));assert.equal(queue.state.pending,2);
  fail=false;assert.equal(await queue.flush(),true);assert.deepEqual(attempts.map(value=>value.id),['one','one','two']);assert.equal(queue.state.pending,0);
});
test('a late acknowledgement retains a deep copy of the edit',async()=>{
  let release;const delayed=new Promise(resolve=>{release=resolve;}),written=[];
  const queue=new EditQueue(async value=>{await delayed;written.push(value);},()=>{}),value=edit('one');queue.enqueue(value);value.remove[0]='different';release();assert.equal(await queue.flush(),true);assert.deepEqual(written,[edit('one')]);
});
