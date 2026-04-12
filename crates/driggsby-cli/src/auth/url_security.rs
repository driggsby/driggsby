use anyhow::{Result, bail};

pub fn assert_broker_remote_url(raw_url: &str, context: &str) -> Result<()> {
    let _ = parse_broker_remote_url(raw_url, context)?;
    Ok(())
}

pub fn parse_broker_remote_url(raw_url: &str, context: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw_url)?;
    if url.scheme() == "https" {
        return Ok(url);
    }

    #[cfg(any(test, debug_assertions))]
    {
        if url.scheme() == "http" && is_loopback_hostname(url.host_str().unwrap_or_default()) {
            return Ok(url);
        }
    }

    bail!("{context} must use https, except for local loopback development.")
}

#[cfg(any(test, debug_assertions))]
fn is_loopback_hostname(hostname: &str) -> bool {
    hostname == "localhost"
        || hostname == "::1"
        || hostname == "[::1]"
        || hostname.starts_with("127.")
}
