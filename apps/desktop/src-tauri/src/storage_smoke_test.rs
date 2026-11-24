//! Optional native integration harness. Not compiled into normal app builds.
use serde_json::Value;
use std::{error::Error, sync::mpsc, thread, time::{Duration, Instant}};
use tauri::{plugin::{Builder, TauriPlugin}, Manager, Webview, Wry};

pub(super) type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

pub(super) fn evaluate(webview: &Webview<Wry>, script: &str) -> TestResult<Value> {
    let (sender, receiver) = mpsc::channel();
    webview.eval_with_callback(script, move |result| { let _ = sender.send(result); })?;
    Ok(serde_json::from_str(&receiver.recv_timeout(Duration::from_secs(5))?)?)
}

pub(super) fn wait_for(webview: &Webview<Wry>, condition: &str) -> TestResult<()> {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        // A newly created HTTP view can still be navigating; WebKit drops
        // callbacks belonging to the replaced document during that transition.
        if matches!(evaluate(webview, condition), Ok(value) if value == true) { return Ok(()); }
        thread::sleep(Duration::from_millis(50));
    }
    let diagnostics = evaluate(webview, "({status:document.getElementById('save-status')?.textContent,error:document.getElementById('error')?.textContent,count:document.getElementById('stroke-count')?.textContent,pdf:document.getElementById('pdf-status')?.textContent,pdfRender:document.getElementById('pdf-background')?.dataset.renderState,visibility:document.visibilityState,focused:document.hasFocus(),raf:window.__pdfTestFrame,sharing:document.getElementById('share-status')?.textContent,connection:document.getElementById('connection')?.textContent})").unwrap_or(Value::Null);
    Err(format!("Timed out: {condition}; {diagnostics}").into())
}

fn close_window(webview: &Webview<Wry>) -> TestResult<()> {
    webview.app_handle().get_webview_window("main").ok_or("Missing main window")?.close()?;
    Ok(())
}

fn run(webview: &Webview<Wry>) -> TestResult<()> {
    let mode = std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE")?;
    if mode == "blocked-load" {
        wait_for(webview, "document.getElementById('save-status').textContent === 'Seite konnte nicht geladen werden'")?;
        evaluate(webview, INJECT_STROKE)?;
        if evaluate(webview, "document.getElementById('stroke-count').textContent")? != "0 Striche" {
            return Err("Drawing was enabled after a failed load.".into());
        }
    } else {
        wait_for(webview, "document.getElementById('save-status').textContent === 'Lokal gespeichert'")?;
        let expected_count = if mode == "seed" { "0 Striche" } else if mode == "quit" { "2 Striche" } else { "1 Strich" };
        if evaluate(webview, "document.getElementById('stroke-count').textContent")? != expected_count {
            return Err("Restored stroke count differs.".into());
        }
        if mode == "restore" {
            let painted = evaluate(webview, "(() => {const c=document.getElementById('page'),r=c.getBoundingClientRect(); return c.getContext('2d').getImageData(Math.floor(100*c.width/r.width),Math.floor(60*c.height/r.height),1,1).data[3]>0;})()")?;
            if painted != true { return Err("Restored geometry was not rendered.".into()); }
        } else {
            let expected = evaluate(webview, INJECT_STROKE)?;
            println!("SMOKE_INPUT {expected}");
            // Close while the pen is still down: the real window-close handler
            // must finish the stroke and await its commit before allowing exit.
            if mode == "failure" {
                close_window(webview)?;
                wait_for(webview, "!document.getElementById('discard-close').hidden && !document.getElementById('storage-retry').hidden")?;
                let directory = std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR").ok_or("Missing test directory")?;
                let connection = rusqlite::Connection::open(std::path::PathBuf::from(directory).join("livemitschrift.sqlite3"))?;
                connection.execute_batch("DROP TRIGGER fail_write")?;
                evaluate(webview, "document.getElementById('storage-retry').click(); true")?;
                wait_for(webview, "document.getElementById('save-status').textContent === 'Lokal gespeichert'")?;
            }
        }
    }
    println!("SMOKE_PASS {mode}");
    if mode == "quit" { webview.app_handle().exit(0); }
    else { close_window(webview)?; }
    thread::sleep(Duration::from_secs(5));
    Err("The native app did not exit after its close request.".into())
}

// Use the app's native input adapter and real rendering/save queue/IPC. This
// validates persistence, not the physical tablet or AppKit event extraction.
const INJECT_STROKE: &str = r#"(() => {
    const c=document.getElementById('page'),r=c.getBoundingClientRect();
    const points=[{x:r.left+100,y:r.top+60,pressure:0.12},{x:r.left+130,y:r.top+80,pressure:0.8}];
    for(const p of points) window.dispatchEvent(new CustomEvent('livemitschrift-native-input',{detail:{...p,phase:'move',pointerType:'pen',buttons:0,button:-1,eraser:false}}));
    const paper=document.getElementById('paper').getBoundingClientRect(),scale=paper.width/1200;
    return points.map(p=>({x:(p.x-paper.left)/scale,y:(p.y-paper.top)/scale,pressure:p.pressure}));
})()"#;

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("storage-smoke-test").on_page_load(|webview, payload| {
        let mode=std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE").unwrap_or_default();
        if mode.starts_with("pdf-") || mode.starts_with("workflow-") { return; }
        if webview.label() == "main"
            && std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE").as_deref() != Ok("live")
            && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let webview = webview.clone();
            thread::spawn(move || {
                if let Err(error) = run(&webview) {
                    eprintln!("SMOKE_FAIL {error}");
                    webview.app_handle().state::<crate::persistence::Lifecycle>()
                        .allow_exit.store(true, std::sync::atomic::Ordering::Relaxed);
                    webview.app_handle().exit(1);
                }
            });
        }
    }).build()
}
