import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotebookEvent, EditHistory, hitStroke, parseNotebookMessage, validNotebookSnapshot } from '../dist/index.js';

const point=(x,y)=>({x,y,pressure:.25});
const stroke=(id,order=0)=>({id,order,color:'#243147',width:3.5,complete:true,points:[point(10,2000),point(100,2100)]});
const page=(id)=>({id,title:'Seite',width:1200,height:6400,background:null,nextOrder:2,strokes:[]});
const snapshot=()=>({type:'notebook',notebook:{id:'book',title:'Mathematik',topics:[{id:'topic',title:'Vorlesung',pages:[{...page('a'),strokes:[stroke('first')]},page('b')]}]},position:{pageId:'a',y:1800,focusY:2100}});

test('notebook snapshots support tall pages, ordered ink and multi-page PDF references',()=>{
  const state=snapshot();assert.equal(validNotebookSnapshot(state),true);
  state.notebook.topics[0].pages[1].background={assetId:'a'.repeat(64),name:'Folien.pdf',pageNumber:2,width:960,height:540};
  assert.equal(validNotebookSnapshot(state),true);
  state.notebook.topics[0].pages[1].id='a';assert.equal(validNotebookSnapshot(state),false);
});
test('invalid geometry, references, active strokes and duplicate orders are rejected before replacement',()=>{
  for(const mutate of [s=>{s.position.pageId='missing';},s=>{s.position.focusY=Infinity;},s=>{s.notebook.topics[0].pages[0].strokes[0].points[0].y=6401;},s=>{s.notebook.topics[0].pages[0].strokes.push(stroke('duplicate-order'));},s=>{s.notebook.topics[0].pages[0].strokes[0].order=-1;}]){const value=snapshot();mutate(value);assert.equal(validNotebookSnapshot(value),false);}
});
test('undo restores original ink order and geometry; redo removes it without touching another page',()=>{
  const state=snapshot(),history=new EditHistory(),original=structuredClone(state.notebook.topics[0].pages[0].strokes[0]);
  const edit=history.record('a',6400,[],[original]);applyNotebookEvent(state.notebook,{type:'edit',edit});
  assert.equal(state.notebook.topics[0].pages[0].strokes.length,0);assert.equal(history.canUndo,true);
  const undo=history.undo();applyNotebookEvent(state.notebook,{type:'edit',edit:undo});assert.deepEqual(state.notebook.topics[0].pages[0].strokes,[original]);
  assert.notEqual(undo.id,edit.id);applyNotebookEvent(state.notebook,{type:'edit',edit:history.redo()});assert.equal(state.notebook.topics[0].pages[0].strokes.length,0);assert.equal(state.notebook.topics[0].pages[1].height,6400);
});
test('new drawing after undo invalidates redo and history owns its geometry',()=>{
  const history=new EditHistory(),value=stroke('a');history.record('page',6400,[value],[]);value.points[0].y=999;
  const undo=history.undo();assert.deepEqual(undo.remove,['a']);assert.equal(history.canRedo,true);
  history.record('page',6400,[stroke('b',1)],[]);assert.equal(history.canRedo,false);
});
test('fast eraser segments cross strokes even when neither sampled endpoint is nearby',()=>{
  const line={...stroke('a'),points:[point(50,0),point(50,100)]};
  assert.equal(hitStroke(line,point(0,50),point(100,50),2),true);
  assert.equal(hitStroke(line,point(0,200),point(100,200),2),false);
  assert.equal(hitStroke({...line,points:[point(50,50)]},point(48,49),point(48,49),3),true);
});
test('page-scoped live ink, extent and edits keep independent pages isolated',()=>{
  const state=snapshot();const start={type:'ink',pageId:'b',operation:{type:'stroke_start',stroke:{...stroke('live'),complete:false,points:[point(10,3000)]}}};
  applyNotebookEvent(state.notebook,parseNotebookMessage(JSON.stringify(start)));
  applyNotebookEvent(state.notebook,{type:'ink',pageId:'b',operation:{type:'stroke_points',stroke_id:'live',points:[point(20,3100)]}});
  applyNotebookEvent(state.notebook,{type:'ink',pageId:'b',operation:{type:'stroke_end',stroke_id:'live'}});
  assert.equal(state.notebook.topics[0].pages[1].strokes[0].points.length,2);assert.equal(state.notebook.topics[0].pages[0].strokes[0].id,'first');
  assert.throws(()=>applyNotebookEvent(state.notebook,{type:'ink',pageId:'a',operation:{type:'stroke_end',stroke_id:'live'}}));
});

test('laser pointer messages are validated, carry only x/y and never change the notebook',()=>{
  assert.deepEqual(parseNotebookMessage(JSON.stringify({type:'pointer',pageId:'a',point:{x:10,y:20,extra:1}})),{type:'pointer',pageId:'a',point:{x:10,y:20}});
  assert.deepEqual(parseNotebookMessage(JSON.stringify({type:'pointer',pageId:'a',point:null})),{type:'pointer',pageId:'a',point:null});
  for (const point of [{x:-1,y:0},{x:1201,y:0},{x:0,y:'1'},undefined]) assert.throws(()=>parseNotebookMessage(JSON.stringify({type:'pointer',pageId:'a',point})));
  const state=snapshot(), before=JSON.stringify(state.notebook);
  applyNotebookEvent(state.notebook,{type:'pointer',pageId:'a',point:{x:1,y:1}});assert.equal(JSON.stringify(state.notebook),before);
});

test('marker strokes are optional and only accept highlighter=true',()=>{
  const state=snapshot();state.notebook.topics[0].pages[0].strokes[0].highlighter=true;assert.equal(validNotebookSnapshot(state),true);
  state.notebook.topics[0].pages[0].strokes[0].highlighter=false;assert.equal(validNotebookSnapshot(state),false);
});
