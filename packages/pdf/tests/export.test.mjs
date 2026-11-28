import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { exportTopicPdf, exportContentHeight, EXPORT_SLICE_HEIGHT } from '../dist/export.js';

const page = () => ({id:'page',title:'Page',width:1200,height:10000,background:null,strokes:[],nextOrder:0});
const stroke = points => ({id:'ink',order:0,color:'#b44049',width:12,complete:true,points:points.map(([x,y,pressure])=>({x,y,pressure}))});

test('export trims growing tails, retains empty pages and splits crossing ink',async()=>{
    const note=page(); note.strokes=[stroke([[200,100,.1],[1000,EXPORT_SLICE_HEIGHT+300,1]])];
    assert.ok(exportContentHeight(note)<note.height);
    const bytes=await exportTopicPdf({id:'topic',title:'Long handwriting',pages:[note,page()]},async()=>{throw Error('Unexpected PDF read');});
    const document=await PDFDocument.load(bytes);assert.equal(document.getPageCount(),3);assert.equal(document.getTitle(),'Long handwriting');
    assert.equal(document.getPage(0).getWidth(),595.28);
    await mkdir('../../output/pdf',{recursive:true});await writeFile('../../output/pdf/handwriting-export.pdf',bytes);
});

test('cropped and rotated original PDF pages remain vector content under ink',async()=>{
    const original=await PDFDocument.create(); const pages=[];
    for(const rotation of [0,90,180,270]) {
        const slide=original.addPage([500,350]);slide.setCropBox(40,30,400,250);slide.setRotation(degrees(rotation));
        slide.drawRectangle({x:40,y:30,width:400,height:250,color:rgb(.95,.95,.95)});
        slide.drawRectangle({x:50,y:40,width:80,height:60,color:rgb(0,0,1)});
        slide.drawRectangle({x:350,y:200,width:80,height:60,color:rgb(0,.65,0)});
        const note=page();note.id=`p-${rotation}`;note.background={assetId:'a'.repeat(64),name:'rotation.pdf',pageNumber:pages.length+1,width:rotation%180?250:400,height:rotation%180?400:250};
        note.strokes=[stroke([[30,30,.1],[1170,30,1]])];pages.push(note);
    }
    const source=await original.save();let reads=0;
    const bytes=await exportTopicPdf({id:'topic',title:'Crop and rotations',pages},async()=>{reads++;return source;});
    assert.equal(reads,1);assert.equal((await PDFDocument.load(bytes)).getPageCount(),6);
    await mkdir('../../output/pdf',{recursive:true});await writeFile('../../output/pdf/rotation-export.pdf',bytes);
});

test('extreme growing pages fail before allocating thousands of export pages',async()=>{
    const note=page();note.height=1e9;note.strokes=[stroke([[100,1e9-1,1]])];
    await assert.rejects(exportTopicPdf({id:'topic',title:'Limit',pages:[note]},async()=>new Uint8Array()),/2000/);
});

test('pagewise browser assets keep original PDF page numbers separate and embed the extracted first page',async()=>{
    const pages=[], assets=new Map();
    for (const number of [1,2]) {
        const document=await PDFDocument.create(),slide=document.addPage([500,350]);
        slide.drawRectangle({x:30,y:30,width:440,height:290,color:number===1?rgb(.2,.5,.8):rgb(.2,.7,.4)});
        slide.drawText(`Slide ${number}`,{x:60,y:180,size:32}); assets.set(number,await document.save());
        const note=page(); note.id=`p-${number}`;
        note.background={assetId:'a'.repeat(64),name:'slides.pdf',pageNumber:number,width:500,height:350};
        note.strokes=[stroke([[100,100,.4],[1000,600,1]])]; pages.push(note);
    }
    const calls=[];
    const result=await exportTopicPdf({id:'topic',title:'Browser export',pages},async(id,number)=>{calls.push([id,number]);return assets.get(number);},{pagewiseAssets:true});
    assert.deepEqual(calls,[['a'.repeat(64),1],['a'.repeat(64),2]]);
    assert.equal((await PDFDocument.load(result)).getPageCount(),2);
    await mkdir('../../output/pdf',{recursive:true}); await writeFile('../../output/pdf/browser-export.pdf',result);
});

test('reader notes become PDF text annotations on the right slice, optionally with printable text pages',async()=>{
    const {PDFName, PDFArray} = await import('pdf-lib');
    const first=page(), second=page(); second.id='second';
    first.strokes=[stroke([[100,100,.5],[200,200,.5]])];
    const text='Ümlaut, Emoji 😀 und\nzweite Zeile';
    const notes={comments:true, printable:false, byPage:new Map([['page',[
        {number:1,x:600,y:300,text,updated:Date.UTC(2026,10,26)},
        {number:2,x:120,y:EXPORT_SLICE_HEIGHT+50,text:'Weiter unten',updated:0}]]])};
    const comments=async bytes=>{
        const document=await PDFDocument.load(bytes);
        return document.getPages().map(target=>{
            const annots=target.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
            return annots ? annots.asArray().map(ref=>{const dict=document.context.lookup(ref);
                return {subtype:dict.get(PDFName.of('Subtype')).toString(),text:dict.lookup(PDFName.of('Contents')).decodeText(),
                    rect:dict.lookup(PDFName.of('Rect')).asArray().map(n=>n.asNumber())};}) : [];
        });
    };
    const plain=await comments(await exportTopicPdf({id:'t',title:'Notes',pages:[first,second]},async()=>{throw Error('no PDF');},{notes}));
    // The second note lies below the ink, so it adds a slice; the empty second page stays one page.
    assert.equal(plain.length,3);
    assert.deepEqual(plain.map(list=>list.map(item=>item.text)),[[text],['Weiter unten'],[]]);
    assert.equal(plain[0][0].subtype,'/Text');
    const [x,,,top]=plain[0][0].rect;
    assert.ok(Math.abs(x-(24+600*(595.28-48)/1200))<.01 && Math.abs(top-(841.89-24-300*(595.28-48)/1200))<.01);
    const printed=await PDFDocument.load(await exportTopicPdf({id:'t',title:'Notes',pages:[first,second]},async()=>{throw Error('no PDF');},{notes:{...notes,printable:true}}));
    assert.equal(printed.getPageCount(),4);
    // Printable text alone, without comments: text page, no annotations.
    const printOnly=await comments(await exportTopicPdf({id:'t',title:'Notes',pages:[first,second]},async()=>{throw Error('no PDF');},{notes:{...notes,comments:false,printable:true}}));
    assert.deepEqual(printOnly,[[],[],[],[]]);
    const without=await PDFDocument.load(await exportTopicPdf({id:'t',title:'Notes',pages:[first,second]},async()=>{throw Error('no PDF');}));
    assert.equal(without.getPageCount(),2);
});

/** A valid 2×2 RGB PNG, built with zlib so pdf-lib can embed it. */
async function tinyPng() {
    const {deflateSync, crc32} = await import('node:zlib');
    const chunk = (type, data) => {
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 0, 0]);
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

test('page images are embedded once, below the ink, on the slices they cover', async () => {
    const {PDFName, PDFDict} = await import('pdf-lib');
    const png = await tinyPng(), asset = 'c'.repeat(64);
    const first = page(), second = page(); second.id = 'second';
    // One image on the first slice, the same file again crossing into the second slice.
    first.images = [{id: 'a', assetId: asset, x: 100, y: 100, width: 300, height: 200, order: 0},
        {id: 'b', assetId: asset, x: 100, y: EXPORT_SLICE_HEIGHT - 50, width: 300, height: 200, order: 1}];
    first.nextOrder = 2;
    assert.equal(exportContentHeight(first), EXPORT_SLICE_HEIGHT + 150);
    let reads = 0;
    const bytes = await exportTopicPdf({id: 't', title: 'Images', pages: [first, second]}, async () => { throw Error('no PDF'); },
        {readImage: async id => { reads++; assert.equal(id, asset); return png; }});
    assert.equal(reads, 1, 'each file is read and embedded once');
    const document = await PDFDocument.load(bytes);
    const imagesOn = target => {
        const objects = target.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        // Distinct image objects: one name per drawing, all pointing to the single embedded file.
        return objects ? new Set(objects.keys().map(key => objects.get(key)).filter(ref => document.context.lookup(ref).dict?.get(PDFName.of('Subtype'))?.toString() === '/Image').map(String)).size : 0;
    };
    const pages = document.getPages();
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map(imagesOn), [1, 1, 0]);
    assert.equal(document.context.enumerateIndirectObjects().filter(([, object]) => object.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image').length, 1);
    const without = await PDFDocument.load(await exportTopicPdf({id: 't', title: 'Images', pages: [first]}, async () => { throw Error('no PDF'); }));
    assert.deepEqual(without.getPages().map(imagesOn), [0, 0], 'without a reader the export stays as before');
});
