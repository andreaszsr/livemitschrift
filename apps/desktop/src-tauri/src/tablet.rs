//! App-local tablet data before WKWebView reduces it to mouse Pointer Events.

use std::{cell::{Cell, RefCell}, ptr::NonNull, rc::Rc};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSEventSubtype, NSEventType, NSPointingDeviceType, NSView, NSWindow};
use objc2_foundation::NSProcessInfo;
use serde::Serialize;
use tauri::{plugin::{Builder, TauriPlugin}, RunEvent, Webview, Wry};

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    static ORIGINAL_COALESCING: Cell<Option<bool>> = const { Cell::new(None) };
}
static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    phase: &'static str,
    pointer_type: &'static str,
    x: f64,
    y: f64,
    pressure: f32,
    buttons: u64,
    button: i64,
    eraser: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimedSample<'a> {
    #[serde(flatten)]
    sample: &'a Sample,
    sequence: u64,
    timestamp: f64,
    sent_at: f64,
    queue_delay_ms: f64,
    mouse_coalescing_enabled: bool,
}

fn publish(webview: &Webview<Wry>, sample: &Sample, timestamp: f64) {
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let sent_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0).unwrap_or(0.0);
    let sample = TimedSample {
        sample, sequence, timestamp: timestamp * 1000.0, sent_at,
        queue_delay_ms: ((NSProcessInfo::processInfo().systemUptime() - timestamp) * 1000.0).max(0.0),
        mouse_coalescing_enabled: NSEvent::isMouseCoalescingEnabled(),
    };
    match serde_json::to_string(&sample) {
        Ok(payload) => {
            // Evaluate in this app's WebView only. No network or global input
            // monitoring permission is used, and the DOM mouse event is left
            // untouched so the pen can still operate HTML controls.
            if let Err(error) = webview.eval(format!(
                "window.dispatchEvent(new CustomEvent('livemitschrift-native-input',{{detail:{payload}}}));"
            )) {
                eprintln!("Cannot deliver native input: {error}");
            }
        }
        Err(error) => eprintln!("Cannot serialize native input: {error}"),
    }
}

fn remove_monitor() {
    MONITOR.with(|slot| {
        if let Some(token) = slot.borrow_mut().take() {
            // SAFETY: This is the token returned by AppKit, removed once on the
            // main event loop before dropping the block's retained views.
            unsafe { NSEvent::removeMonitor(&token) };
        }
    });
    ORIGINAL_COALESCING.with(|value| {
        if let Some(enabled) = value.take() { NSEvent::setMouseCoalescingEnabled(enabled); }
    });
}

pub fn coalescing(enabled: Option<bool>) -> bool {
    if let Some(enabled) = enabled { NSEvent::setMouseCoalescingEnabled(enabled); }
    NSEvent::isMouseCoalescingEnabled()
}

fn install(webview: Webview<Wry>) -> tauri::Result<()> {
    let output = webview.clone();
    webview.with_webview(move |platform| {
        // SAFETY: Tauri provides live WKWebView/NSWindow pointers on the main
        // thread. WKWebView inherits NSView. The retained objects stay on the
        // AppKit event loop inside the monitor block.
        let (Some(view), Some(window)) = (unsafe {
            (Retained::<NSView>::retain(platform.inner().cast()),
             Retained::<NSWindow>::retain(platform.ns_window().cast()))
        }) else {
            eprintln!("Native tablet adapter has no WebView/window");
            return;
        };
        remove_monitor();
        ORIGINAL_COALESCING.with(|value| value.set(Some(NSEvent::isMouseCoalescingEnabled())));
        let eraser = Rc::new(Cell::new(false));
        let tool_probe = cfg!(feature = "workflow-smoke-test") && std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE").as_deref() == Ok("workflow-tools-manual");
        let last_buttons = Rc::new(Cell::new(None));
        let callback = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit lends this event for the duration of the callback;
            // returning the original pointer preserves normal event dispatch.
            let native = unsafe { event.as_ref() };
            let kind = native.r#type();
            if kind == NSEventType::Magnify {
                if window.isKeyWindow() && (native.windowNumber() == window.windowNumber() || native.windowNumber() == 0) {
                    let location = if native.windowNumber() == 0 {window.mouseLocationOutsideOfEventStream()} else {native.locationInWindow()};
                    let point = view.convertPoint_fromView(location, None);
                    let bounds = view.bounds();
                    let layout = view.convertRect_fromView(window.contentLayoutRect(), None);
                    let x = point.x - bounds.origin.x.max(layout.origin.x);
                    let y = if view.isFlipped() {point.y - bounds.origin.y.max(layout.origin.y)} else {
                        (bounds.origin.y + bounds.size.height).min(layout.origin.y + layout.size.height) - point.y
                    };
                    let phase = native.phase();
                    let phase = if phase.contains(NSEventPhase::Began) {"start"}
                        else if phase.contains(NSEventPhase::Ended) {"end"}
                        else if phase.contains(NSEventPhase::Cancelled) {"cancel"} else {"change"};
                    let magnification = native.magnification();
                    if x.is_finite() && y.is_finite() && magnification.is_finite() {
                        let payload = serde_json::json!({"phase":phase,"x":x,"y":y,"magnification":magnification});
                        if let Err(error) = output.eval(format!("window.dispatchEvent(new CustomEvent('livemitschrift-native-zoom',{{detail:{payload}}}));")) {
                            eprintln!("Cannot deliver native zoom: {error}");
                        }
                    }
                    // The document handles magnification. Prevent a second
                    // WKWebView page zoom from also scaling the toolbar/input.
                    return std::ptr::null_mut();
                }
                return event.as_ptr();
            }
            // subtype is a mouse-event property; pure tablet events are already
            // identified by their type and must not be queried as mouse events.
            let subtype = if kind == NSEventType::TabletPoint || kind == NSEventType::TabletProximity {
                NSEventSubtype::MouseEvent
            } else { native.subtype() };
            let proximity = kind == NSEventType::TabletProximity
                || subtype == NSEventSubtype::TabletProximity;
            if proximity {
                // Device type is valid on proximity events, not tablet points.
                eraser.set(native.pointingDeviceType() == NSPointingDeviceType::Eraser);
                if !native.isEnteringProximity() {
                    publish(&output, &Sample { phase: "leave", pointer_type: "pen",
                        x: 0.0, y: 0.0, pressure: 0.0, buttons: 0, button: -1,
                        eraser: eraser.get() }, native.timestamp());
                }
                return event.as_ptr();
            }
            let tablet = kind == NSEventType::TabletPoint
                || subtype == NSEventSubtype::TabletPoint;
            let window_number = native.windowNumber();
            if !window.isKeyWindow() || (window_number != window.windowNumber()
                && !(tablet && window_number == 0)) {
                return event.as_ptr();
            }
            let phase = match kind {
                NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown => "down",
                NSEventType::LeftMouseUp | NSEventType::RightMouseUp | NSEventType::OtherMouseUp => "up",
                NSEventType::LeftMouseDragged | NSEventType::RightMouseDragged | NSEventType::OtherMouseDragged => "drag",
                _ => "move",
            };
            // AppKit window coordinates start at the bottom left. WKWebView can
            // extend under the title bar while its CSS viewport starts below it.
            // Use the visible content layout, intersected with the WebView, as
            // the client origin; the outer view bounds alone include that inset.
            // Points remain logical units, not Retina backing pixels.
            // Pressure-only tablet events may have no associated window. In
            // that case AppKit supplies the current cursor in window units.
            let location = if window_number == 0 { window.mouseLocationOutsideOfEventStream() }
                else { native.locationInWindow() };
            let point = view.convertPoint_fromView(location, None);
            let bounds = view.bounds();
            let layout = view.convertRect_fromView(window.contentLayoutRect(), None);
            let x = point.x - bounds.origin.x.max(layout.origin.x);
            let y = if view.isFlipped() {
                point.y - bounds.origin.y.max(layout.origin.y)
            } else {
                (bounds.origin.y + bounds.size.height)
                    .min(layout.origin.y + layout.size.height) - point.y
            };
            if !x.is_finite() || !y.is_finite() { return event.as_ptr(); }
            let pressure = if tablet { native.pressure() } else if phase == "down"
                || kind == NSEventType::LeftMouseDragged { 1.0 } else { 0.0 };
            let buttons = if tablet { native.buttonMask().bits() as u64 }
                else { NSEvent::pressedMouseButtons() as u64 };
            if tool_probe {
                let signature = (tablet, buttons, pressure > 0.0, eraser.get());
                if last_buttons.get() != Some(signature) || phase == "down" || phase == "up" {
                    let button = if phase == "move" {-1} else {native.buttonNumber()};
                    eprintln!("TOOLS_INPUT tablet={tablet} phase={phase} buttons={buttons} button={button} pressure={pressure:.3} eraser={}", eraser.get());
                    last_buttons.set(Some(signature));
                }
            }
            publish(&output, &Sample {
                phase, pointer_type: if tablet { "pen" } else { "mouse" },
                x, y, pressure: if pressure.is_finite() { pressure.clamp(0.0, 1.0) } else { 0.0 },
                buttons, button: if phase == "move" { -1 } else { native.buttonNumber() as i64 },
                eraser: tablet && eraser.get(),
            }, native.timestamp());
            event.as_ptr()
        });
        let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp
            | NSEventMask::LeftMouseDragged | NSEventMask::RightMouseDown
            | NSEventMask::RightMouseUp | NSEventMask::RightMouseDragged
            | NSEventMask::OtherMouseDown | NSEventMask::OtherMouseUp
            | NSEventMask::OtherMouseDragged | NSEventMask::MouseMoved
            | NSEventMask::TabletPoint | NSEventMask::TabletProximity | NSEventMask::Magnify;
        // SAFETY: The callback always returns the borrowed event unchanged.
        let token = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &callback) };
        if token.is_none() { eprintln!("Cannot install native tablet monitor"); }
        MONITOR.with(|slot| *slot.borrow_mut() = token);
    })
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("native-tablet")
        // Set before page scripts run, so DOM mouse emulation cannot create a
        // duplicate stroke before the first native tablet sample arrives.
        .js_init_script("window.__LIVEMITSCHRIFT_NATIVE_INPUT__ = true;")
        .on_webview_ready(|webview| {
            if webview.label() == "main" {
                if let Err(error) = install(webview) {
                    eprintln!("Cannot initialize native tablet adapter: {error}");
                }
            }
        })
        .on_event(|_, event| {
            if matches!(event, RunEvent::Exit) { remove_monitor(); }
        })
        .build()
}

// Known-rate bridge load, not a tablet/driver sampling-rate measurement.
#[cfg(feature = "workflow-smoke-test")]
pub(super) fn probe_bridge(webview: &Webview<Wry>, x: f64, y: f64, hz: u32, seconds: u32) -> tauri::Result<()> {
    let start = std::time::Instant::now();
    let count = hz * seconds;
    let mut last = (x + 120.0, y);
    for index in 0..=count {
        let due = std::time::Duration::from_secs_f64(index as f64 / hz as f64);
        if let Some(delay) = due.checked_sub(start.elapsed()) { std::thread::sleep(delay); }
        let angle = index as f64 / hz as f64 * std::f64::consts::TAU;
        last = (x+120.0*angle.cos(),y+120.0*angle.sin());
        let timestamp = NSProcessInfo::processInfo().systemUptime();
        let output = webview.clone();
        // Real AppKit samples and this producer share the main loop, preserving
        // sequence order even if the user moves the mouse during a probe.
        webview.run_on_main_thread(move || publish(&output, &Sample {
            phase:if index==0 {"down"} else {"drag"},pointer_type:"pen",
            x:last.0,y:last.1,pressure:0.5,buttons:1,button:0,eraser:false}, timestamp))?;
    }
    let output = webview.clone();
    let timestamp = NSProcessInfo::processInfo().systemUptime();
    webview.run_on_main_thread(move || publish(&output, &Sample {
        phase:"up",pointer_type:"pen",x:last.0,y:last.1,pressure:0.0,buttons:0,button:0,eraser:false}, timestamp))?;
    Ok(())
}
