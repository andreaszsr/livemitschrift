//! Open only a validated HTTP(S) read link, with arguments passed without a shell.
fn viewer_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|error| error.to_string())?;
    let identity = url.path().strip_prefix("/notebook/").unwrap_or("");
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid live-view URL.".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_live_viewer(url: String) -> Result<(), String> {
    let url = viewer_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let program = if cfg!(target_os = "macos") { "open" }
            else if cfg!(target_os = "windows") { "explorer.exe" } else { "xdg-open" };
        let status = std::process::Command::new(program).arg(url.as_str())
            .status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("Cannot open the default browser.".into()) }
    }).await.map_err(|error| error.to_string())?
}

/// Links in text boxes: only https and mailto, without credentials.
fn external_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|error| error.to_string())?;
    let valid = match url.scheme() {
        "https" => url.host_str().is_some() && url.username().is_empty() && url.password().is_none(),
        "mailto" => !url.path().is_empty(),
        _ => false,
    };
    if !valid || value.len() > 2000 { return Err("Only https and mailto links can be opened.".into()); }
    Ok(url)
}

#[tauri::command]
pub async fn open_link(url: String) -> Result<(), String> {
    let url = external_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The URL is one argument of `open`, never interpreted by a shell.
        let status = std::process::Command::new("open").arg(url.as_str())
            .status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("Cannot open the link.".into()) }
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{external_url, viewer_url};
    #[test]
    fn text_box_links_open_only_https_and_mailto() {
        assert!(external_url("https://example.org/skript?x=1#a").is_ok());
        assert!(external_url("mailto:dozent@example.org").is_ok());
        for url in ["http://example.org", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.org", "tel:123", "mailto:"] {
            assert!(external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn opens_only_http_read_links_and_rejects_other_schemes_or_commands() {
        assert!(viewer_url(&format!("http://127.0.0.1:8000/notebook/{}", "a".repeat(64))).is_ok());
        for url in ["file:///etc/passwd", "https://example.com/", "javascript:alert(1)", "http://example.com/notebook/a;open"] {
            assert!(viewer_url(url).is_err());
        }
    }
}
