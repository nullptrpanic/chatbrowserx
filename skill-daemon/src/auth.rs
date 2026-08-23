use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

const HEADER: &str = r#"{"alg":"HS256","typ":"JWT"}"#;
const MINIMUM_SECRET_LENGTH: usize = 32;
const SECONDS_PER_DAY: u64 = 86_400;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize)]
struct Claims<'a> {
    sub: &'a str,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct OwnedClaims {
    sub: String,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
}

pub(crate) fn issue(secret: &str, plugin_identifier: &str, expiration_days: u64) -> Result<String> {
    validate_secret(secret)?;
    let plugin_identifier = plugin_identifier.trim();
    if plugin_identifier.is_empty() {
        bail!("plugin identifier must not be empty");
    }
    if expiration_days == 0 {
        bail!("expire must be greater than zero");
    }
    let issued_at = unix_time()?;
    let expires_at = expiration_days
        .checked_mul(SECONDS_PER_DAY)
        .and_then(|duration| issued_at.checked_add(duration))
        .context("expire is too large")?;
    let payload = serde_json::to_vec(&Claims {
        sub: plugin_identifier,
        iat: issued_at,
        exp: expires_at,
    })
    .context("failed to encode token claims")?;
    let header = URL_SAFE_NO_PAD.encode(HEADER);
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let signed = format!("{header}.{payload}");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .context("failed to initialize token signer")?;
    mac.update(signed.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{signed}.{signature}"))
}

pub(crate) fn verify(secret: &str, token: &str) -> bool {
    if validate_secret(secret).is_err() {
        return false;
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(format!("{header}.{payload}").as_bytes());
    if mac.verify_slice(&signature).is_err() {
        return false;
    }
    let Ok(header) = URL_SAFE_NO_PAD.decode(header) else {
        return false;
    };
    let Ok(header) = serde_json::from_slice::<Header>(&header) else {
        return false;
    };
    if header.alg != "HS256" || header.typ != "JWT" {
        return false;
    }
    let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<OwnedClaims>(&payload) else {
        return false;
    };
    let Ok(now) = unix_time() else {
        return false;
    };
    !claims.sub.trim().is_empty() && claims.iat > 0 && now < claims.exp
}

pub(crate) fn validate_secret(secret: &str) -> Result<()> {
    if secret.len() < MINIMUM_SECRET_LENGTH {
        bail!("daemon config secret must be at least 32 bytes");
    }
    Ok(())
}

fn unix_time() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_secs())
}
