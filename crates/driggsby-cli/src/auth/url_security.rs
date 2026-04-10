use anyhow::{Result, bail};

pub fn assert_broker_remote_url(raw_url: &str, context: &str) -> Result<()> {
    let url = url::Url::parse(raw_url)?;
    if url.scheme() == "https"
        || (url.scheme() == "http" && is_loopback_hostname(url.host_str().unwrap_or_default()))
    {
        return Ok(());
    }

    bail!("{context} must use https, except for local loopback development.")
}

fn is_loopback_hostname(hostname: &str) -> bool {
    hostname == "localhost"
        || hostname == "::1"
        || hostname == "[::1]"
        || hostname.starts_with("127.")
}
