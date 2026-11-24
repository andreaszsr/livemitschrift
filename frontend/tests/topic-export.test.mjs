import test from 'node:test';
import assert from 'node:assert/strict';
import {loadExportTopic, exportFilename} from '../dist/topic-export.js';

const page = id => ({id, title:id, width:1200, height:6400, background:null, nextOrder:1,
    strokes:[{id:'ink', order:0, complete:true, color:'#243147', width:3.5,
        points:[{x:100,y:5000,pressure:.4}]}]});

test('export reads every selected topic page fully and preserves source/cache objects', async () => {
    const topic={id:'topic',title:'Lecture',pages:[{...page('a'),strokes:[]},{...page('b'),strokes:[]}]};
    const before=structuredClone(topic), calls=[], progress=[];
    const result=await loadExportTopic(topic, async id=>{calls.push(id);return page(id);}, new AbortController().signal,
        (loaded,total)=>progress.push([loaded,total]));
    assert.deepEqual(calls,['a','b']); assert.deepEqual(topic,before);
    assert.equal(result.pages[1].strokes[0].points[0].y,5000);
    assert.deepEqual(progress,[[0,2],[1,2],[2,2]]);
});

test('an invalid, mismatched or in-progress page cannot become a partial successful export', async () => {
    const topic={id:'t',title:'Lecture',pages:[page('a')]};
    for (const value of [null,page('wrong'),{...page('a'),strokes:[{...page('a').strokes[0],complete:false}]}])
        await assert.rejects(loadExportTopic(topic,async()=>value,new AbortController().signal,()=>{}),/Ungültiger/);
});

test('cancellation stops reading further pages and read failures propagate', async () => {
    const controller=new AbortController(), ids=[];
    const topic={id:'t',title:'Lecture',pages:[page('a'),page('b')]};
    await assert.rejects(loadExportTopic(topic,async id=>{ids.push(id);controller.abort();return page(id);},controller.signal,()=>{}),{name:'AbortError'});
    assert.deepEqual(ids,['a']);
    await assert.rejects(loadExportTopic(topic,async()=>{throw Error('offline');},new AbortController().signal,()=>{}),/offline/);
});

test('download filenames retain the topic name without path/control characters or duplicate extension', () => {
    assert.equal(exportFilename('Mathematik.pdf'),'Mathematik.pdf');
    assert.equal(exportFilename('../Folien: 1/2\n'),'.._Folien_ 1_2_.pdf');
    assert.equal(exportFilename('... '),'Mitschrift.pdf');
});

test('the browser export enforces a whole-topic point budget across individually valid pages', async () => {
    const points=Array(100000).fill({x:100,y:5000,pressure:.4});
    const read=id=>({...page(id),nextOrder:11,strokes:Array.from({length:11},(_,index)=>
        ({...page(id).strokes[0],id:`ink-${index}`,order:index,points}))});
    await assert.rejects(loadExportTopic({id:'t',title:'Large',pages:[page('a'),page('b')]},
        async id=>read(id),new AbortController().signal,()=>{}),/zu groß/);
});
