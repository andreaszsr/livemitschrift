//! End-to-end teaching workflow, driven only in an explicitly isolated app build.
use crate::storage_smoke_test::{evaluate,wait_for,TestResult};
use std::{fs,path::{Path,PathBuf},thread,time::{Duration,Instant}};
use tauri::{plugin::{Builder,TauriPlugin},Manager,Webview,WebviewUrl,WebviewWindow,WebviewWindowBuilder,Wry};

fn click(webview:&Webview<Wry>,selector:&str)->TestResult<()>{
    evaluate(webview,&format!("(() => {{const node=document.querySelector({});if(!node||node.disabled)throw Error('Missing enabled control');node.click();return true;}})()",serde_json::to_string(selector)?)).map_err(|error|format!("Click {selector} failed: {error}"))?;
    control_help(webview)
}
fn control_help(webview:&Webview<Wry>)->TestResult<()> {
    let missing=evaluate(webview,"[...document.querySelectorAll('button,input:not([type=file]),select,a[href],summary')].filter(n=>n.getClientRects().length&&!n.title.trim()).map(n=>n.id||n.getAttribute('aria-label')||n.tagName)")?;
    if missing.as_array().map_or(true,|items|!items.is_empty()) {return Err(format!("Controls without hover help: {missing}").into());}
    Ok(())
}
fn drag_action(webview:&Webview<Wry>,id:&str,target:&str,before:Option<&str>,cancel:bool)->TestResult<()> {
    evaluate(webview,&format!(r#"(() => {{
        const handle=document.querySelector('.customizer-row[data-id='+{id}+'] .customizer-grip');
        const zone=document.querySelector('.customizer-zone[data-target='+{target}+']');
        const before={before},row=before?zone.querySelector('[data-id='+before+']'):null;
        const source=handle.getBoundingClientRect(),dest=(row??zone).getBoundingClientRect();
        const x=dest.left+12,y=row?dest.top+2:dest.bottom-8;
        handle.dispatchEvent(new PointerEvent('pointerdown',{{pointerId:41,button:0,buttons:1,clientX:source.left+8,clientY:source.top+8,bubbles:true,cancelable:true}}));
        document.dispatchEvent(new PointerEvent('pointermove',{{pointerId:41,buttons:1,clientX:x,clientY:y,bubbles:true,cancelable:true}}));
        if(!document.querySelector('.customizer-drop'))throw Error('Missing insertion marker');
        document.dispatchEvent(new PointerEvent({end},{{pointerId:41,button:0,buttons:0,clientX:x,clientY:y,bubbles:true}}));
        return true;
    }})()"#,id=serde_json::to_string(id)?,target=serde_json::to_string(target)?,before=serde_json::to_string(&before)?,end=serde_json::to_string(if cancel{"pointercancel"}else{"pointerup"})?))?;
    Ok(())
}
fn action(webview:&Webview<Wry>,id:&str)->TestResult<()>{
    let primary=format!("#toolbar [data-action='{id}']");
    if evaluate(webview,&format!("!!document.querySelector({})",serde_json::to_string(&primary)?))?==true {
        click(webview,&primary)
    } else {
        if evaluate(webview,"document.getElementById('tools-panel').hidden")?==true {
            click(webview,"#toolbar [data-action=tools]")?;
        }
        let tool=format!("#tools-panel [data-action='{id}']");
        if evaluate(webview,&format!("!!document.querySelector({})",serde_json::to_string(&tool)?))?==true {
            return click(webview,&tool);
        }
        // Rarely used administration actions live in the settings dialog.
        if id=="settings" {return Err("Missing settings action".into());}
        action(webview,"settings")?;
        click(webview,&format!("#editor-dialog .settings-actions [data-action='{id}']"))
    }
}
fn saved(webview:&Webview<Wry>,count:usize)->TestResult<()>{wait_for(webview,&format!("document.getElementById('save-status')?.textContent==='Lokal gespeichert'&&document.getElementById('stroke-count')?.textContent==='{} {}'",count,if count==1{"Strich"}else{"Striche"}))}
fn page(webview:&Webview<Wry>,number:usize)->TestResult<()>{wait_for(webview,&format!("document.querySelector('.page-count')?.textContent==='{} / 2'",number))}
fn pdf(webview:&Webview<Wry>)->TestResult<()>{
    let window=webview.app_handle().get_webview_window(webview.label()).ok_or("Missing PDF test window")?;
    // WebKit suspends rendering when a window is occluded by another app too.
    // Keep only the window currently being verified above normal windows.
    window.set_always_on_top(true)?;window.show()?;window.set_focus()?;
    let result=(||{evaluate(webview,"window.__pdfTestFrame='waiting';requestAnimationFrame(()=>{window.__pdfTestFrame='fired';});true")?;wait_for(webview,"document.getElementById('pdf-background')?.dataset.assetReady==='true'")})();
    window.set_always_on_top(false)?;
    result
}
fn select_pdf(webview:&Webview<Wry>,bytes:&[u8],name:&str)->TestResult<()>{
    evaluate(webview,&format!("(() => {{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array({})],{},{{type:'application/pdf'}}));const field=document.getElementById('pdf-file');field.files=transfer.files;field.dispatchEvent(new Event('change',{{bubbles:true}}));return true;}})()",serde_json::to_string(bytes)?,serde_json::to_string(name)?))?;Ok(())
}
fn draw(webview:&Webview<Wry>,x:f64,y:f64)->TestResult<()>{
    wait_for(webview,&format!("(() => {{const p=document.getElementById('paper').getBoundingClientRect(),s=p.width/1200;return document.elementFromPoint(p.left+{x}*s,p.top+{y}*s)===document.getElementById('page');}})()"))?;
    evaluate(webview,&format!("(() => {{const p=document.getElementById('paper').getBoundingClientRect(),s=p.width/1200;const x=p.left+{x}*s,y=p.top+{y}*s;for(const [phase,dx,buttons]of [['down',0,1],['drag',15,1],['up',15,0]])window.dispatchEvent(new CustomEvent('livemitschrift-native-input',{{detail:{{phase,x:x+dx,y,pointerType:'mouse',pressure:0,buttons,button:0,eraser:false}}}}));return true;}})()"))?;Ok(())
}
/// The writing canvas covers only the visible area and follows scrolling one frame later; wait until it is under the point.
fn canvas_at(webview:&Webview<Wry>,x:f64,y:f64)->TestResult<()>{
    wait_for(webview,&format!("(() => {{const p=document.getElementById('paper').getBoundingClientRect(),s=p.width/1200;return document.elementFromPoint(p.left+{x}*s,p.top+{y}*s)===document.getElementById('page');}})()"))
}
fn pen(webview:&Webview<Wry>,phase:&str,x:f64,y:f64,buttons:u8)->TestResult<()>{
    evaluate(webview,&format!("(() => {{const p=document.getElementById('paper').getBoundingClientRect(),s=p.width/1200;window.dispatchEvent(new CustomEvent('livemitschrift-native-input',{{detail:{{phase:'{phase}',x:p.left+{x}*s,y:p.top+{y}*s,pointerType:'mouse',pressure:0,buttons:{buttons},button:0,eraser:false}}}}));return true;}})()"))?;Ok(())
}
/// Hold-to-straighten: a wavy stroke rests at (500, y), turns into a line preview, then its end follows the pen to (550, y).
fn straight_line(webview:&Webview<Wry>,y:f64)->TestResult<()>{
    canvas_at(webview,300.0,y)?;
    pen(webview,"down",300.0,y,1)?;
    for (x,dy) in [(350.0,40.0),(400.0,50.0),(450.0,40.0),(500.0,0.0)]{pen(webview,"drag",x,y+dy,1)?;}
    wait_for(webview,"document.querySelector('.selection-overlay line')?.closest('svg').style.display===''")?;
    pen(webview,"drag",550.0,y,1)?;pen(webview,"up",550.0,y,0)?;
    wait_for(webview,"document.querySelector('.selection-overlay line').closest('svg').style.display==='none'")
}
fn stroke_total(webview:&Webview<Wry>)->TestResult<usize>{
    Ok(evaluate(webview,"parseInt(document.getElementById('stroke-count').textContent)")?.as_u64().ok_or("Missing stroke count")? as usize)
}
/// Drag a shape with the pen; returns the preview path shown just before pen-up.
fn shape(webview:&Webview<Wry>,from:(f64,f64),to:(f64,f64))->TestResult<String>{
    canvas_at(webview,from.0,from.1)?;
    pen(webview,"down",from.0,from.1,1)?;
    pen(webview,"drag",(from.0+to.0)/2.0,(from.1+to.1)/2.0,1)?;
    pen(webview,"drag",to.0,to.1,1)?;
    wait_for(webview,"document.querySelector('.shape-preview').style.display===''")?;
    let path=evaluate(webview,"document.querySelector('.shape-preview path').getAttribute('d')")?;
    pen(webview,"up",to.0,to.1,0)?;
    wait_for(webview,"document.querySelector('.shape-preview').style.display==='none'")?;
    Ok(path.as_str().unwrap_or_default().to_string())
}
fn scroll(webview:&Webview<Wry>,y:f64)->TestResult<()>{
    evaluate(webview,&format!("(() => {{const p=document.getElementById('paper').getBoundingClientRect();document.getElementById('viewport').scrollTop={y}*p.width/1200;return true;}})()"))?;
    wait_for(webview,&format!("Math.abs(document.getElementById('viewport').scrollTop*1200/document.getElementById('paper').getBoundingClientRect().width-{y})<3"))
}
fn followed(instructor:&Webview<Wry>,reader:&Webview<Wry>)->TestResult<()>{
    let visible="(() => {const p=document.getElementById('paper').getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect();return Math.max(0,(v.top-p.top)*1200/p.width);})()";
    let y=evaluate(instructor,visible)?.as_f64().ok_or("Missing document viewport")?;
    wait_for(reader,&format!("Math.abs(({visible})-{y})<2&&document.getElementById('follow-return').hidden"))
}
fn painted(webview:&Webview<Wry>,x:f64,y:f64,expected:bool)->TestResult<()>{
    wait_for(webview,&format!("(() => {{const c=document.getElementById('page'),p=document.getElementById('paper').getBoundingClientRect(),r=c.getBoundingClientRect(),s=p.width/1200;const x=({x}*s+p.left-r.left)*c.width/r.width,y=({y}*s+p.top-r.top)*c.height/r.height;if(x<0||y<0||x>=c.width||y>=c.height)return false;return (c.getContext('2d').getImageData(Math.floor(x),Math.floor(y),1,1).data[3]>0)==={expected};}})()"))
}
fn reader(webview:&Webview<Wry>,label:&str,url:&str,width:f64)->TestResult<WebviewWindow<Wry>>{
    let reader=WebviewWindowBuilder::new(webview.app_handle(),label,WebviewUrl::External(url.parse()?)).title("LiveMitschrift · Workflow-Browser").inner_size(width,800.0).build()?;
    // macOS suspends PDF animation frames when another test window fully covers this one.
    reader.show()?;reader.set_focus()?;
    wait_for(reader.as_ref(),"document.getElementById('connection')?.textContent?.startsWith('Live verbunden')")?;pdf(reader.as_ref())?;control_help(reader.as_ref())?;Ok(reader)
}
fn wait_file(path:&Path)->TestResult<()>{let deadline=Instant::now()+Duration::from_secs(20);while Instant::now()<deadline{if path.is_file(){return Ok(());}thread::sleep(Duration::from_millis(50));}Err(format!("Missing signal {}",path.display()).into())}
fn start_sharing(webview:&Webview<Wry>)->TestResult<String>{
    evaluate(webview,&format!("document.getElementById('share-key').value='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';document.getElementById('share-server').value={};if(document.getElementById('share-status').dataset.state==='off')document.getElementById('share-toggle').click();true",serde_json::to_string(&std::env::var("LIVEMITSCHRIFT_LIVE_SMOKE_SERVER")?)?))?;
    wait_for(webview,"document.getElementById('share-status')?.dataset.state==='live'")?;
    wait_for(webview,"document.querySelector('.connection-indicator')?.dataset.connection==='live'&&document.querySelector('.connection-indicator').title.includes('Live verbunden')")?;
    Ok(evaluate(webview,"document.getElementById('viewer-link').href")?.as_str().ok_or("Missing notebook URL")?.to_owned())
}

fn writing_toolbar(webview:&Webview<Wry>)->TestResult<()> {
    wait_for(webview,"document.getElementById('tools-panel').hidden&&!!document.querySelector('#toolbar [data-action=undo]')&&!document.querySelector('#toolbar [data-action=zoom]')&&!document.querySelector('#toolbar [data-action=import]')")?;
    control_help(webview)?;
    wait_for(webview,"document.querySelector('.connection-indicator')?.dataset.connection==='off'&&document.querySelector('.connection-indicator').title.includes('Nur lokal')")?;
    let top=evaluate(webview,"document.getElementById('paper').getBoundingClientRect().top")?.as_f64().ok_or("Missing paper")?;
    let bar_top=evaluate(webview,"document.getElementById('toolbar').getBoundingClientRect().top")?.as_f64().ok_or("Missing writing bar")?;
    action(webview,"tools")?;
    control_help(webview)?;
    wait_for(webview,&format!("!document.getElementById('tools-panel').hidden&&document.querySelector('#toolbar [data-action=tools]').getAttribute('aria-expanded')==='true'&&Math.abs(document.getElementById('paper').getBoundingClientRect().top-{top})<1"))?;
    wait_for(webview,"(() => {const p=document.getElementById('tools-panel'),b=document.getElementById('toolbar'),first=p.querySelector('button');return p.getBoundingClientRect().top===0&&first.getBoundingClientRect().top<20&&b.getBoundingClientRect().top>=p.getBoundingClientRect().bottom+8;})()")?;
    action(webview,"tools")?;
    wait_for(webview,&format!("document.getElementById('tools-panel').hidden&&Math.abs(document.getElementById('toolbar').getBoundingClientRect().top-{bar_top})<1"))?;
    // Moving the bar below the panel must not leave a reserved blank row above its tools.
    evaluate(webview,"(() => {for(let i=0;i<25;i++)document.querySelector('.toolbar-grip').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return true;})()")?;
    let lower_top=evaluate(webview,"document.getElementById('toolbar').getBoundingClientRect().top")?.as_f64().ok_or("Missing moved writing bar")?;
    action(webview,"tools")?;
    wait_for(webview,&format!("Math.abs(document.getElementById('toolbar').getBoundingClientRect().top-{lower_top})<1&&document.querySelector('#tools-panel button').getBoundingClientRect().top<20"))?;
    action(webview,"tools")?;
    evaluate(webview,"document.querySelector('.toolbar-grip').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));true")?;
    click(webview,"#toolbar [aria-controls=drawer]")?;
    control_help(webview)?;
    action(webview,"tools")?;
    wait_for(webview,&format!("(() => {{const d=document.getElementById('drawer'),p=document.getElementById('tools-panel');return !d.hidden&&!p.hidden&&d.getBoundingClientRect().top>=p.getBoundingClientRect().bottom&&document.querySelector('#toolbar [aria-controls=drawer]').getAttribute('aria-expanded')==='true'&&Math.abs(document.getElementById('paper').getBoundingClientRect().top-{top})<1;}})()"))?;
    click(webview,"#drawer [aria-label='Drawer schließen']")?;
    wait_for(webview,"document.getElementById('drawer').hidden&&!document.getElementById('tools-panel').hidden")?;
    click(webview,"#toolbar [aria-controls=drawer]")?;
    wait_for(webview,"!document.getElementById('drawer').hidden&&!document.getElementById('tools-panel').hidden")?;
    action(webview,"tools")?;
    wait_for(webview,"!document.getElementById('drawer').hidden&&document.getElementById('tools-panel').hidden")?;
    click(webview,"#drawer [aria-label='Drawer schließen']")?;
    action(webview,"pen-presets")?;
    control_help(webview)?;
    click(webview,"[aria-label='Farbe hinzufügen']")?;click(webview,"[aria-label='Strichdicke hinzufügen']")?;
    wait_for(webview,"document.querySelectorAll('[data-pen-color^=pen-]').length===5&&document.querySelectorAll('[data-pen-width^=pen-]').length===4")?;
    click(webview,"[aria-label='Farbe 5 entfernen']")?;click(webview,"[aria-label='Strichdicke 4 entfernen']")?;
    evaluate(webview,"(() => {const c=document.querySelector('[data-pen-color=\"pen-0\"]'),w=document.querySelector('[data-pen-width=\"pen-0\"]');c.value='#123456';c.dispatchEvent(new Event('input'));w.value='2';w.dispatchEvent(new Event('input'));return true;})()")?;
    click(webview,".pen-presets-form button[type=submit]")?;
    wait_for(webview,"!document.getElementById('editor-dialog').open&&document.querySelector('#toolbar [data-action=color-0]').style.getPropertyValue('--ink-color')==='#123456'&&document.querySelector('#toolbar [data-action=width-0]').getAttribute('aria-label')==='Strichdicke 2'")?;
    action(webview,"width-0")?;action(webview,"pen")?;
    wait_for(webview,"!document.getElementById('editor-dialog').open&&document.querySelector('#toolbar [data-action=width-0]').getAttribute('aria-pressed')==='true'")?;
    action(webview,"width-1")?;
    action(webview,"pen-presets")?;
    evaluate(webview,"(() => {const c=document.querySelector('[data-pen-color=\"pen-0\"]');c.value='#ffffff';c.dispatchEvent(new Event('input'));document.getElementById('editor-dialog').close();return true;})()")?;
    wait_for(webview,"document.querySelector('#toolbar [data-action=color-0]').style.getPropertyValue('--ink-color')==='#123456'")?;
    action(webview,"customize")?;
    control_help(webview)?;
    drag_action(webview,"color-0","toolbar",Some("undo"),false)?;
    wait_for(webview,"document.querySelector('#toolbar .toolbar-actions>button').dataset.action==='color-0'&&document.querySelector('.customizer-zone[data-target=toolbar] .customizer-row').dataset.id==='color-0'")?;
    drag_action(webview,"undo","menu",None,true)?;
    wait_for(webview,"!!document.querySelector('.customizer-zone[data-target=toolbar] [data-id=undo]')&&!document.querySelector('.customizer-drop')")?;
    drag_action(webview,"eraser","menu",None,false)?;
    wait_for(webview,"!!document.querySelector('.customizer-zone[data-target=menu] [data-id=eraser]')&&!document.querySelector('#toolbar .toolbar-actions [data-action=eraser]')")?;
    drag_action(webview,"eraser","toolbar",Some("width-0"),false)?;
    wait_for(webview,"!!document.querySelector('#toolbar .toolbar-actions [data-action=eraser]')")?;
    click(webview,".customizer [data-action=pen-presets]")?;
    wait_for(webview,"!document.querySelector('.customizer').open&&document.querySelector('.pen-presets-form')!==null")?;
    for _ in 0..3 {click(webview,"[aria-label='Farbe hinzufügen']")?;}
    for width in [4.2,8.4,12.35] {
        click(webview,"[aria-label='Strichdicke hinzufügen']")?;
        evaluate(webview,&format!("(() => {{const w=[...document.querySelectorAll('[data-pen-width^=pen-]')].at(-1);w.value='{width}';w.dispatchEvent(new Event('input'));return true;}})()"))?;
    }
    evaluate(webview,"(() => {const c=document.querySelector('[data-pen-color-hex=\"pen-6\"]');c.value='#118899';c.dispatchEvent(new Event('input'));return true;})()")?;
    click(webview,".pen-presets-form button[type=submit]")?;
    wait_for(webview,"!document.getElementById('editor-dialog').open&&document.querySelector('#toolbar [data-action=color-6]').style.getPropertyValue('--ink-color')==='#118899'&&document.querySelector('#toolbar [data-action=width-5]').getAttribute('aria-label')==='Strichdicke 12,35'")?;
    println!("TOOLBAR_PASS independent panels without overlap, compact top panel, floating bar avoidance/restoration without moving paper; direct presets, configurable favorites, cancel and pen selection");
    Ok(())
}
fn local(webview:&Webview<Wry>,directory:&Path)->TestResult<()>{
    saved(webview,1)?;
    writing_toolbar(webview)?;
    wait_for(webview,"document.getElementById('input-high-rate').checked")?;
    select_pdf(webview,&fs::read(std::env::var_os("LIVEMITSCHRIFT_WORKFLOW_PDF").ok_or("Missing PDF fixture")?)?,"Vorlesung.pdf")?;
    page(webview,1)?;pdf(webview)?;saved(webview,0)?;
    wait_for(webview,"(() => {const c=document.getElementById('pdf-background'),p=c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;return Math.abs(p[0]-57)<5&&Math.abs(p[1]-117)<5&&Math.abs(p[2]-102)<5;})()")?;
    click(webview,".page-count")?;
    wait_for(webview,"document.querySelectorAll('.thumbnail canvas[data-preview-ready=true]').length===2")?;
    wait_for(webview,"(() => {const c=document.querySelector('.thumbnail canvas'),p=c.getContext('2d').getImageData(128,72,1,1).data;return Math.abs(p[0]-57)<5&&Math.abs(p[1]-117)<5&&Math.abs(p[2]-102)<5;})()")?;
    evaluate(webview,"document.getElementById('editor-dialog').close();true")?;
    draw(webview,600.0,337.5)?;saved(webview,1)?;painted(webview,600.0,337.5,true)?;
    evaluate(webview,"(() => {const r=document.getElementById('paper').getBoundingClientRect(),s=r.width/1200,x=r.left+600*s,y=r.top+337.5*s;for(const [pressure,buttons]of [[0,2],[.4,3],[0,2],[0,0]])window.dispatchEvent(new CustomEvent('livemitschrift-native-input',{detail:{phase:'move',pointerType:'pen',x,y,pressure,buttons,button:-1,eraser:false}}));return true;})()")?;
    saved(webview,0)?;wait_for(webview,"document.getElementById('paper').dataset.tool==='pen'")?;
    action(webview,"undo")?;saved(webview,1)?;painted(webview,600.0,337.5,true)?;
    action(webview,"redo")?;saved(webview,0)?;action(webview,"undo")?;saved(webview,1)?;
    click(webview,"#toolbar [aria-label='Nächste Seite']")?;page(webview,2)?;pdf(webview)?;saved(webview,0)?;
    action(webview,"color-1")?;draw(webview,300.0,350.0)?;saved(webview,1)?;
    click(webview,"#toolbar [aria-label='Vorherige Seite']")?;page(webview,1)?;saved(webview,1)?;
    for _ in 0..4{
        let height=evaluate(webview,"document.getElementById('paper').getBoundingClientRect().height")?.as_f64().ok_or("Missing paper height")?;
        evaluate(webview,"document.getElementById('viewport').scrollTop=document.getElementById('viewport').scrollHeight;true")?;
        wait_for(webview,&format!("document.getElementById('paper').getBoundingClientRect().height>{height}+100"))?;
    }
    scroll(webview,4800.0)?;action(webview,"color-1")?;draw(webview,400.0,5000.0)?;saved(webview,2)?;painted(webview,400.0,5000.0,true)?;
    wait_for(webview,"document.getElementById('page').height<=(document.getElementById('viewport').clientHeight+3)*devicePixelRatio&&document.getElementById('paper').getBoundingClientRect().height>document.getElementById('viewport').clientHeight*4")?;
    action(webview,"zoom")?;evaluate(webview,"document.getElementById('zoom').value='125';document.getElementById('zoom').dispatchEvent(new Event('change'));document.getElementById('editor-dialog').close();true")?;
    painted(webview,400.0,5000.0,true)?;
    evaluate(webview,"(() => {const p=document.getElementById('paper').getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),x=(v.left+v.right)/2,y=(v.top+v.bottom)/2;window.__zoomAnchor={x:(x-p.left)*1200/p.width,y:(y-p.top)*1200/p.width};window.dispatchEvent(new CustomEvent('livemitschrift-native-zoom',{detail:{phase:'change',magnification:.2,x,y}}));return true;})()")?;
    wait_for(webview,"(() => {const p=document.getElementById('paper').getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect();return Math.abs(p.width-1800)<1&&Math.abs(((v.left+v.right)/2-p.left)*1200/p.width-window.__zoomAnchor.x)<1&&Math.abs(((v.top+v.bottom)/2-p.top)*1200/p.width-window.__zoomAnchor.y)<1;})()")?;
    action(webview,"zoom-lock")?;
    evaluate(webview,"window.dispatchEvent(new CustomEvent('livemitschrift-native-zoom',{detail:{phase:'change',magnification:.5,x:500,y:400}}));requestAnimationFrame(()=>{window.__zoomLockDone=true;});true")?;
    wait_for(webview,"window.__zoomLockDone&&Math.abs(document.getElementById('paper').getBoundingClientRect().width-1800)<1")?;
    action(webview,"zoom-lock")?;action(webview,"zoom")?;
    evaluate(webview,"document.getElementById('zoom').value='75';document.getElementById('zoom').dispatchEvent(new Event('change'));document.getElementById('editor-dialog').close();true")?;
    action(webview,"zoom-lock")?;
    select_pdf(webview,b"not a valid PDF","broken.pdf")?;wait_for(webview,"!document.getElementById('error').hidden")?;saved(webview,2)?;page(webview,1)?;
    evaluate(webview,"document.getElementById('error').hidden=true;true")?;
    action(webview,"placement")?;wait_for(webview,"!document.getElementById('toolbar').classList.contains('floating')")?;
    action(webview,"tools")?;click(webview,"#toolbar [aria-controls=drawer]")?;
    wait_for(webview,"(() => {const d=document.getElementById('drawer'),p=document.getElementById('tools-panel');return !d.hidden&&!p.hidden&&d.getBoundingClientRect().top>=p.getBoundingClientRect().bottom;})()")?;
    click(webview,"#tools-panel [aria-label='Werkzeugleiste schließen']")?;
    wait_for(webview,"!document.getElementById('drawer').hidden&&document.getElementById('tools-panel').hidden")?;
    click(webview,"#drawer [aria-label='Drawer schließen']")?;
    // Configure the real shared toolbar through its accessible move buttons.
    click(webview,".toolbar-more")?;click(webview,".toolbar-menu [aria-label='Leiste anpassen']")?;
    click(webview,".customizer [aria-label='Strichdicke 7 ins Menü']")?;
    evaluate(webview,"document.querySelector('.customizer').close();true")?;
    println!("WORKFLOW_PASS temporary lower-button erasing/restore, anchored pinch and locked zoom");
    println!("WORKFLOW_PASS seeded ink, two PDF pages, separate ink, eraser, undo/redo, long page, bounded canvas, zoom and invalid import");
    fs::write(directory.join("local-passed"),"ready")?;Ok(())
}
fn live(webview:&Webview<Wry>,directory:&Path)->TestResult<()>{
    saved(webview,2)?;page(webview,1)?;pdf(webview)?;
    wait_for(webview,"document.querySelector('#toolbar [data-action=color-0]').style.getPropertyValue('--ink-color')==='#123456'&&document.querySelector('#toolbar [data-action=width-0]').getAttribute('aria-label')==='Strichdicke 2'")?;
    wait_for(webview,"document.querySelector('#toolbar .toolbar-actions>button').dataset.action==='color-0'&&document.querySelector('#toolbar [data-action=color-6]').style.getPropertyValue('--ink-color')==='#118899'&&document.querySelector('#toolbar [data-action=width-5]').getAttribute('aria-label')==='Strichdicke 12,35'")?;
    wait_for(webview,"Math.abs(document.getElementById('paper').getBoundingClientRect().width-900)<1&&document.querySelector('#tools-panel [data-action=zoom-lock]').getAttribute('aria-pressed')==='true'")?;
    wait_for(webview,"!document.getElementById('toolbar').classList.contains('floating')&&!document.querySelector('#toolbar [data-action=width-2]')&&!document.querySelector('#toolbar [data-action=zoom]')")?;
    scroll(webview,4800.0)?;painted(webview,400.0,5000.0,true)?;
    let url=start_sharing(webview)?;fs::write(directory.join("read-url"),&url)?;
    let first=reader(webview,"workflow-reader-a",&url,1000.0)?;
    wait_for(first.as_ref(),"document.getElementById('stroke-count')?.textContent==='2 Striche'&&!document.getElementById('toolbar').classList.contains('floating')")?;
    painted(first.as_ref(),400.0,5000.0,true)?;
    evaluate(first.as_ref(),"document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-20,clientX:400,clientY:400,bubbles:true,cancelable:true}));true")?;
    wait_for(first.as_ref(),"!document.getElementById('follow-return').hidden&&document.getElementById('paper').getBoundingClientRect().width>1000")?;
    action(first.as_ref(),"zoom-lock")?;action(first.as_ref(),"zoom-lock")?;action(first.as_ref(),"zoom")?;
    evaluate(first.as_ref(),"const z=document.querySelector('#viewer-dialog select');z.value='fit';z.dispatchEvent(new Event('change'));document.getElementById('viewer-dialog').close();true")?;
    click(first.as_ref(),"#follow-return")?;
    // A shorter reader must follow scrolling, not chase ink below its viewport.
    evaluate(first.as_ref(),"(() => {const v=document.getElementById('viewport');v.style.flex='none';v.style.height='320px';return true;})()")?;
    followed(webview,first.as_ref())?;
    let before=evaluate(first.as_ref(),"document.getElementById('viewport').scrollTop")?.as_f64().ok_or("Missing reader scroll")?;
    draw(webview,600.0,5600.0)?;saved(webview,3)?;
    wait_for(first.as_ref(),"document.getElementById('stroke-count')?.textContent==='3 Striche'")?;
    thread::sleep(Duration::from_millis(250));
    wait_for(first.as_ref(),&format!("Math.abs(document.getElementById('viewport').scrollTop-{before})<1&&document.getElementById('follow-return').hidden"))?;
    scroll(webview,5200.0)?;followed(webview,first.as_ref())?;
    scroll(webview,4800.0)?;followed(webview,first.as_ref())?;
    evaluate(first.as_ref(),"(() => {const v=document.getElementById('viewport');v.style.flex='';v.style.height='';return true;})()")?;
    followed(webview,first.as_ref())?;
    println!("WORKFLOW_PASS shorter reader stays still during ink and follows instructor scroll in both directions");
    straight_line(webview,5300.0)?;saved(webview,4)?;
    wait_for(first.as_ref(),"document.getElementById('stroke-count')?.textContent==='4 Striche'")?;
    for view in [webview,first.as_ref()]{painted(view,525.0,5300.0,true)?;painted(view,400.0,5350.0,false)?;}
    action(webview,"undo")?;saved(webview,3)?;
    wait_for(first.as_ref(),"document.getElementById('stroke-count')?.textContent==='3 Striche'")?;painted(first.as_ref(),525.0,5300.0,false)?;
    println!("WORKFLOW_PASS hold-to-straighten replaces a wavy stroke by a movable straight line for instructor and reader; undo removes it");
    click(first.as_ref(),"#toolbar [aria-label='Nächste Seite']")?;page(first.as_ref(),2)?;
    wait_for(first.as_ref(),"!document.getElementById('follow-return').hidden&&document.getElementById('stroke-count').textContent==='1 Strich'")?;
    click(webview,"#toolbar [aria-label='Nächste Seite']")?;page(webview,2)?;
    click(webview,"#toolbar [aria-label='Vorherige Seite']")?;page(webview,1)?;page(first.as_ref(),2)?;
    click(first.as_ref(),"#follow-return")?;page(first.as_ref(),1)?;
    painted(first.as_ref(),400.0,5000.0,true)?;
    println!("WORKFLOW_PASS saved PDF restart, persistent toolbar preferences, HTTP reader, page/scroll follow and independent navigation");
    fs::write(directory.join("stop-server"),"ready")?;wait_file(&directory.join("server-stopped"))?;
    wait_for(webview,"document.getElementById('share-status').dataset.state==='reconnecting'")?;
    wait_for(webview,"document.querySelector('.connection-indicator')?.dataset.connection==='reconnecting'&&document.querySelector('.connection-indicator').title.includes('Verbindung unterbrochen')")?;
    action(webview,"eraser")?;draw(webview,400.0,5000.0)?;saved(webview,2)?;
    action(webview,"color-1")?;draw(webview,700.0,5400.0)?;saved(webview,3)?;
    fs::write(directory.join("offline-ink-ready"),"ready")?;wait_file(&directory.join("server-restarted"))?;
    wait_for(first.as_ref(),"document.getElementById('connection')?.textContent?.startsWith('Live verbunden')&&document.getElementById('stroke-count')?.textContent==='3 Striche'")?;
    painted(first.as_ref(),400.0,5000.0,false)?;painted(first.as_ref(),700.0,5400.0,true)?;
    let late=reader(webview,"workflow-reader-b",&url,780.0)?;
    painted(late.as_ref(),700.0,5400.0,true)?;
    evaluate(late.as_ref(),"document.getElementById('page').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:400,clientY:300}));true")?;
    wait_for(late.as_ref(),"document.getElementById('stroke-count').textContent==='3 Striche'")?;
    if evaluate(webview,"document.getElementById('viewer-link').href")?!=url{return Err("Read link changed after relay restart".into());}
    first.set_focus()?;
    let scroll_before=evaluate(first.as_ref(),"document.getElementById('viewport').scrollTop")?;
    // The viewer's CSP (connect-src 'self') forbids fetching blob: URLs, so keep the Blob it creates.
    evaluate(first.as_ref(),"(() => {const create=URL.createObjectURL;URL.createObjectURL=blob=>{window.__studentBlob=blob;return create.call(URL,blob);};return true;})()")?;
    action(first.as_ref(),"export")?;
    wait_for(first.as_ref(),"document.getElementById('export-dialog').open&&!document.getElementById('export-download').hidden")?;
    evaluate(first.as_ref(),"window.__studentPdf=null;void(async()=>{window.__studentPdf=Array.from(new Uint8Array(await window.__studentBlob.arrayBuffer()));})().catch(error=>{window.__studentPdf=String(error);});true")?;
    wait_for(first.as_ref(),"window.__studentPdf!==null")?;
    // A failed download leaves its error message instead of the bytes.
    if evaluate(first.as_ref(),"Array.isArray(window.__studentPdf)&&window.__studentPdf.length>100")?!=true {
        return Err(format!("Student PDF download failed: {}",evaluate(first.as_ref(),"String(window.__studentPdf).slice(0,300)")?).into());
    }
    let bytes:Vec<u8>=serde_json::from_value(evaluate(first.as_ref(),"window.__studentPdf")?)?;
    fs::write(directory.join("student-export.pdf"),bytes)?;
    click(first.as_ref(),"#export-close")?;
    if evaluate(first.as_ref(),"document.getElementById('viewport').scrollTop")?!=scroll_before {return Err("PDF export moved the reader viewport".into());}
    println!("BROWSER_EXPORT_PASS read-only HTTP viewer builds full multi-page vector PDF without changing navigation");
    println!("WORKFLOW_PASS actual relay restart, offline erasing/writing, PDF reupload, late reader and read-only input");
    fs::write(directory.join("live-passed"),"ready")?;Ok(())
}
fn locked_credentials(webview:&Webview<Wry>,directory:&Path)->TestResult<()> {
    saved(webview,3)?;
    wait_for(webview,"document.querySelector('.connection-indicator')?.dataset.connection==='error'&&document.querySelector('.connection-indicator').title.includes('Schlüssel benötigt')&&document.querySelector('.save-indicator').dataset.state==='ready'")?;
    click(webview,".connection-indicator")?;
    wait_for(webview,"document.getElementById('sharing-dialog').open&&document.getElementById('share-key').value===''")?;
    click(webview,"#share-load-key")?;
    wait_for(webview,"document.getElementById('share-key').value.length===64")?;
    click(webview,"#share-toggle")?;
    wait_for(webview,"document.querySelector('.connection-indicator').dataset.connection==='live'")?;
    println!("KEYCHAIN_PASS unavailable silent read leaves editor saved/offline; explicit key load reconnects without replacing local ink");
    fs::write(directory.join("keychain-passed"),"ready")?;Ok(())
}
fn reopen(webview:&Webview<Wry>,directory:&Path)->TestResult<()>{
    saved(webview,3)?;page(webview,1)?;pdf(webview)?;let url=start_sharing(webview)?;
    if url!=fs::read_to_string(directory.join("read-url"))?{return Err("Desktop restart changed the notebook link".into());}
    let reader=reader(webview,"workflow-reader-reopen",&url,900.0)?;
    wait_for(reader.as_ref(),"document.getElementById('stroke-count')?.textContent==='3 Striche'")?;
    println!("WORKFLOW_PASS desktop restart preserves committed edits and notebook read link");fs::write(directory.join("reopen-passed"),"ready")?;Ok(())
}
fn library(webview:&Webview<Wry>,directory:&Path)->TestResult<()> {
    local(webview,directory)?;
    // Export dialog: default name and range, remembered folder, all pages, then replace on a second export.
    action(webview,"export")?;
    wait_for(webview,"/^\\d{4}-\\d{2}-\\d{2}_.+_Meine Notizen$/.test(document.querySelector('#editor-dialog [name=export-name]')?.value)&&document.querySelector('#editor-dialog [name=export-range]').value==='1'&&document.querySelector('#editor-dialog [value=range]').checked")?;
    evaluate(webview,"(() => {const f=document.querySelector('.export-form');f.querySelector('[name=export-name]').value='export';f.querySelector('[name=export-range]').value='9';f.requestSubmit();return true;})()")?;
    wait_for(webview,"document.querySelector('.export-message').textContent.startsWith('Ungültiger Bereich')")?;
    evaluate(webview,"(() => {const f=document.querySelector('.export-form');f.querySelector('[value=all]').checked=true;f.requestSubmit();return true;})()")?;
    wait_file(&directory.join("export.pdf"))?;
    wait_for(webview,"document.querySelector('.export-message').textContent==='Gespeichert: export.pdf'")?;
    evaluate(webview,"document.getElementById('editor-dialog').close();true")?;
    wait_for(webview,"!document.querySelector('#toolbar [aria-controls=drawer]').disabled")?;
    action(webview,"export")?;
    wait_for(webview,&format!("document.querySelector('.export-folder span').textContent==={}&&document.querySelector('.export-form p').textContent.includes('zuletzt exportiert bis Seite')",serde_json::to_string(&directory.to_string_lossy())?))?;
    evaluate(webview,"(() => {const f=document.querySelector('.export-form');f.querySelector('[name=export-name]').value='export.pdf';f.requestSubmit();return true;})()")?;
    wait_for(webview,"document.querySelector('body>dialog[open] .danger')?.textContent==='Ersetzen'")?;
    click(webview,"body>dialog[open] .danger")?;
    wait_for(webview,"document.querySelector('.export-message').textContent==='Gespeichert: export.pdf'")?;
    evaluate(webview,"document.getElementById('editor-dialog').close();true")?;
    wait_for(webview,"!document.querySelector('#toolbar [aria-controls=drawer]').disabled")?;
    // Grid: a 5 mm notebook default scales with the paper; the page can switch it off and inherit again.
    action(webview,"grid")?;
    wait_for(webview,"document.querySelectorAll('#editor-dialog .grid-fields').length===3&&document.querySelector('.page-grid').hidden")?;
    let choose=|scope:usize,value:&str|evaluate(webview,&format!("(() => {{const s=document.querySelectorAll('#editor-dialog .grid-fields')[{scope}].querySelector('select');s.value='{value}';s.dispatchEvent(new Event('change'));return true;}})()"));
    choose(0,"squares")?;
    // The grid period must be 5 mm in container units and those units must resolve against the paper width.
    // WebKit may serialize calc(100cqw * f) as calc(Ncqw ...), so accept both forms.
    wait_for(webview,"(() => {const g=document.querySelector('.page-grid'),paper=document.getElementById('paper'),image=g.style.backgroundImage,long=/100cqw \\* ([\\d.]+)/.exec(image),short=/([\\d.]+)cqw/.exec(image);const units=long?100*Number(long[1]):short?Number(short[1]):NaN;const probe=document.createElement('div');probe.style.cssText=`position:absolute;width:${units}cqw`;paper.append(probe);const cell=probe.getBoundingClientRect().width;probe.remove();return !g.hidden&&image.startsWith('repeating-linear-gradient')&&Math.abs(units-100*5/210)<1e-3&&Math.abs(cell-paper.clientWidth*5/210)<0.5;})()")?;
    choose(2,"none")?;
    wait_for(webview,"document.querySelector('.page-grid').hidden")?;
    choose(2,"inherit")?;
    wait_for(webview,"!document.querySelector('.page-grid').hidden")?;
    choose(0,"none")?;
    wait_for(webview,"document.querySelector('.page-grid').hidden")?;
    evaluate(webview,"document.getElementById('editor-dialog').close();true")?;
    // Shapes: a rectangle, a circle from the shape menu and a snapped quadrant; each undoes as one step.
    scroll(webview,0.0)?;
    let before=stroke_total(webview)?;
    action(webview,"shape")?;
    wait_for(webview,"document.querySelector('#toolbar [data-action=shape]').getAttribute('aria-pressed')==='true'")?;
    shape(webview,(300.0,300.0),(500.0,420.0))?;saved(webview,before+1)?;
    action(webview,"shape")?;click(webview,"#editor-dialog [data-shape=circle]")?;
    shape(webview,(700.0,400.0),(760.0,400.0))?;saved(webview,before+2)?;
    action(webview,"snap")?;
    action(webview,"shape")?;click(webview,"#editor-dialog [data-shape=quadrant]")?;
    let path=shape(webview,(310.0,620.0),(520.0,480.0))?;saved(webview,before+4)?;
    // Without a page grid, snapping uses 5 mm (1200 units = 210 mm): the origin lies on that grid.
    if evaluate(webview,&format!("(() => {{const s=5*1200/210;return {}.startsWith(`M${{Math.round(310/s)*s}} ${{Math.round(620/s)*s}}L`);}})()",serde_json::to_string(&path)?))?!=true {
        return Err(format!("Quadrant origin not snapped: {path}").into());
    }
    for count in [before+2,before+1,before] {action(webview,"undo")?;saved(webview,count)?;}
    action(webview,"snap")?;action(webview,"pen")?;
    click(webview,"[aria-label='Notizbücher und Themen']")?;
    click(webview,"#drawer [aria-label='Notizbücher und Themen verwalten']")?;
    click(webview,"[aria-label='Meine Notizen umbenennen']")?;
    evaluate(webview,"document.querySelector('#editor-dialog input').value='Backup lecture';document.querySelector('#editor-dialog form').requestSubmit();true")?;
    wait_for(webview,"document.querySelector('.management-row>span')?.textContent==='Backup lecture'")?;
    evaluate(webview,"document.getElementById('editor-dialog').close();true")?;
    wait_for(webview,"!document.querySelector('#toolbar [aria-controls=drawer]').disabled")?;
    action(webview,"backup")?;wait_file(&directory.join("export.livemitschrift"))?;
    wait_for(webview,"!document.querySelector('#toolbar [aria-controls=drawer]').disabled")?;
    evaluate(webview,&format!("(() => {{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array({})],'backup.livemitschrift'));const field=document.getElementById('backup-file');field.files=transfer.files;field.dispatchEvent(new Event('change',{{bubbles:true}}));return true;}})()",serde_json::to_string(&fs::read(directory.join("export.livemitschrift"))?)?))?;
    wait_for(webview,"document.querySelectorAll('#drawer select option').length===2")?;
    saved(webview,1)?;
    // Restore closes the tool panel; open the drawer through its visible toggle.
    wait_for(webview,"!document.querySelector('#toolbar [aria-controls=drawer]').disabled")?;
    click(webview,"#toolbar [aria-controls=drawer]")?;
    // Navigate to the copied PDF topic; its background must resolve locally.
    click(webview,"#drawer .topic-button:last-child")?;saved(webview,2)?;pdf(webview)?;
    let url=start_sharing(webview)?;fs::write(directory.join("read-url"),&url)?;
    wait_for(webview,"document.getElementById('share-status').textContent==='Live · Serverstand bestätigt'")?;
    let reader=reader(webview,"library-reader",&url,900.0)?;
    wait_for(reader.as_ref(),"document.getElementById('stroke-count')?.textContent==='2 Striche'")?;
    println!("LIBRARY_PASS native vector PDF export, portable backup, safe copied restore, rename, durable publish and HTTP reader");
    fs::write(directory.join("library-passed"),"ready")?;Ok(())
}

fn sync_seed(webview:&Webview<Wry>,directory:&Path)->TestResult<()> {
    saved(webview,1)?;
    wait_for(webview,"!document.querySelector('#toolbar .brand')&&document.title.startsWith('LiveMitschrift')")?;
    evaluate(webview,&format!("document.getElementById('share-key').value='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';document.getElementById('share-server').value={};document.getElementById('share-toggle').click();true",serde_json::to_string(&std::env::var("LIVEMITSCHRIFT_LIVE_SMOKE_SERVER")?)?))?;
    wait_for(webview,"document.getElementById('share-toggle').textContent==='Synchronisation anhalten'&&!document.querySelector('[data-action=pen]').disabled")?;
    draw(webview,400.0,400.0)?;saved(webview,2)?;
    println!("DURABLE_PASS native offline input and opt-in target committed before normal close");
    fs::write(directory.join("seed-passed"),"ready")?;Ok(())
}
fn sync_resume(webview:&Webview<Wry>,directory:&Path)->TestResult<()> {
    saved(webview,2)?;
    wait_for(webview,"document.getElementById('share-status').dataset.state==='live'")?;
    let url=evaluate(webview,"document.getElementById('viewer-link').href")?.as_str().ok_or("Missing read link")?.to_owned();
    let reader=WebviewWindowBuilder::new(webview.app_handle(),"sync-brand-reader",WebviewUrl::External(url.parse()?)).title("LiveMitschrift · Browsertest").inner_size(900.0,800.0).build()?;
    wait_for(reader.as_ref(),"document.querySelector('#toolbar .brand')?.textContent==='LiveMitschrift'&&document.title.includes('LiveMitschrift')")?;
    fs::write(directory.join("read-url"),url)?;
    println!("BRAND_PASS editor toolbar has no product name; HTTP viewer shows LiveMitschrift");
    println!("DURABLE_PASS native automatic restart confirms retained offline changes without replacing local ink");
    fs::write(directory.join("resume-passed"),"ready")?;Ok(())
}

fn sync_denied(webview:&Webview<Wry>,directory:&Path)->TestResult<()> {
    saved(webview,2)?;
    wait_for(webview,"document.getElementById('share-status').dataset.state==='error'&&document.getElementById('share-status').textContent.includes('Zugangsschlüssel')")?;
    println!("AUTH_PASS native publisher rejects the wrong operator key and retains local saved ink");
    fs::write(directory.join("denied-passed"),"ready")?;Ok(())
}

fn run(webview:&Webview<Wry>)->TestResult<()>{
    let directory=PathBuf::from(std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR").ok_or("Missing isolated directory")?);
    let main=webview.app_handle().get_webview_window("main").ok_or("Missing main window")?;
    main.show()?;main.set_focus()?;
    let mode=std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE")?;
    if mode=="workflow-tools-manual" {
        saved(webview,1)?;main.set_title("LiveMitschrift · Gesten- und Stifttest")?;
        println!("TOOLS_READY isolated pinch/zoom-lock/lower-button test");return Ok(());
    }
    if mode=="workflow-input-manual" {
        saved(webview,0)?;main.set_title("LiveMitschrift · Wacom-Eingabemessung")?;
        evaluate(webview,"document.getElementById('diagnostics-dialog').showModal();true")?;
        fs::write(directory.join("input-ready"),"ready")?;
        println!("INPUT_READY isolated Wacom measurement; use Stiftrate vergleichen");
        return Ok(());
    }
    if mode=="workflow-input-bridge" {
        saved(webview,0)?;
        evaluate(webview,"document.getElementById('profile-start').click();true")?;
        for label in ["Messung 1/2","Messung 2/2"] {
            wait_for(webview,&format!("document.getElementById('profile-phase').textContent.startsWith({})",serde_json::to_string(label)?))?;
            let bounds=evaluate(webview,"(() => {const r=document.getElementById('paper').getBoundingClientRect();return {x:r.left+r.width/2,y:400};})()")?;
            crate::tablet::probe_bridge(webview,bounds["x"].as_f64().ok_or("Missing x")?,bounds["y"].as_f64().ok_or("Missing y")?,240,8)?;
        }
        wait_for(webview,"document.getElementById('profile-file').textContent.startsWith('Messprotokoll:')")?;
        println!("INPUT_PASS known 240 Hz producer traversed Rust/WebKit/input/rendering in both settings");
        main.close()?;return Ok(());
    }
    match std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE")?.as_str(){"workflow-local"=>local(webview,&directory)?,"workflow-live"=>live(webview,&directory)?,"workflow-reopen"=>reopen(webview,&directory)?,"workflow-keychain-locked"=>locked_credentials(webview,&directory)?,"workflow-library"=>library(webview,&directory)?,"workflow-sync-seed"=>sync_seed(webview,&directory)?,"workflow-sync-resume"=>sync_resume(webview,&directory)?,"workflow-sync-denied"=>sync_denied(webview,&directory)?,_=>return Err("Unknown workflow test".into())}
    webview.app_handle().get_webview_window("main").ok_or("Missing main window")?.close()?;thread::sleep(Duration::from_secs(5));Err("App did not close after saving".into())
}
pub fn init()->TauriPlugin<Wry>{
    Builder::new("workflow-smoke-test").on_page_load(|webview,payload|{
        if webview.label()=="main"&&std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE").unwrap_or_default().starts_with("workflow-")&&matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){let webview=webview.clone();thread::spawn(move||if let Err(error)=run(&webview){eprintln!("WORKFLOW_FAIL {error}");webview.app_handle().state::<crate::persistence::Lifecycle>().allow_exit.store(true,std::sync::atomic::Ordering::Relaxed);webview.app_handle().exit(1);});}
    }).build()
}
