use anyhow::Result;

pub async fn open_browser_url(url: &str) -> Result<bool> {
    Ok(open::that_detached(url).is_ok())
}
