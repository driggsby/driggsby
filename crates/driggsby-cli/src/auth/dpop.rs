use anyhow::{Result, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use p256::{
    SecretKey,
    ecdsa::SigningKey,
    elliptic_curve::{rand_core::OsRng, sec1::ToEncodedPoint},
    pkcs8::EncodePrivateKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Jwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedDpopKeyMaterial {
    pub algorithm: String,
    pub created_at: String,
    pub private_jwk: Jwk,
    pub public_jwk: Jwk,
    pub thumbprint: String,
}

#[derive(Debug, Serialize)]
struct DpopClaims {
    htm: String,
    htu: String,
    iat: i64,
    jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ath: Option<String>,
}

pub fn generate_dpop_key_material() -> Result<GeneratedDpopKeyMaterial> {
    let signing_key = SigningKey::random(&mut OsRng);
    let secret_key = SecretKey::from(signing_key);
    let private_jwk = secret_key_to_jwk(&secret_key, true)?;
    let public_jwk = secret_key_to_jwk(&secret_key, false)?;
    let thumbprint = jwk_thumbprint(&public_jwk)?;

    Ok(GeneratedDpopKeyMaterial {
        algorithm: "ES256".to_string(),
        created_at: chrono_like_now(),
        private_jwk,
        public_jwk,
        thumbprint,
    })
}

pub fn create_dpop_proof(
    private_jwk: &Jwk,
    public_jwk: &Jwk,
    http_method: &str,
    target_url: &str,
    access_token: Option<&str>,
) -> Result<String> {
    let signing_key = signing_key_from_jwk(private_jwk)?;
    let der = signing_key.to_pkcs8_der()?.as_bytes().to_vec();
    let mut header = Header::new(Algorithm::ES256);
    header.typ = Some("dpop+jwt".to_string());
    header.jwk = Some(serde_json::from_value(serde_json::to_value(public_jwk)?)?);

    let claims = DpopClaims {
        htm: http_method.to_uppercase(),
        htu: normalize_dpop_target_url(target_url)?,
        iat: time::OffsetDateTime::now_utc().unix_timestamp(),
        jti: uuid::Uuid::now_v7().to_string(),
        ath: access_token.map(token_hash),
    };

    Ok(encode(&header, &claims, &EncodingKey::from_ec_der(&der))?)
}

pub fn normalize_dpop_target_url(target_url: &str) -> Result<String> {
    let mut url = url::Url::parse(target_url)?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

pub fn token_hash(access_token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes()))
}

pub fn signing_key_from_jwk(jwk: &Jwk) -> Result<SigningKey> {
    let secret = jwk.d.as_ref().ok_or_else(|| {
        anyhow::anyhow!("The local CLI signing key is missing private key material.")
    })?;
    let scalar = decode_base64url(secret)?;
    let secret_key = SecretKey::from_slice(&scalar)?;
    Ok(SigningKey::from(secret_key))
}

fn secret_key_to_jwk(secret_key: &SecretKey, include_private: bool) -> Result<Jwk> {
    let public = secret_key.public_key();
    let encoded = public.to_encoded_point(false);
    let x = encoded
        .x()
        .ok_or_else(|| anyhow::anyhow!("Missing public key x coordinate."))?;
    let y = encoded
        .y()
        .ok_or_else(|| anyhow::anyhow!("Missing public key y coordinate."))?;
    let d = if include_private {
        Some(URL_SAFE_NO_PAD.encode(secret_key.to_bytes()))
    } else {
        None
    };

    Ok(Jwk {
        kty: "EC".to_string(),
        crv: "P-256".to_string(),
        x: URL_SAFE_NO_PAD.encode(x),
        y: URL_SAFE_NO_PAD.encode(y),
        d,
    })
}

fn jwk_thumbprint(jwk: &Jwk) -> Result<String> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        bail!("Driggsby sign-in requires P-256 DPoP keys.");
    }

    let mut map = Map::new();
    map.insert("crv".to_string(), json!(jwk.crv));
    map.insert("kty".to_string(), json!(jwk.kty));
    map.insert("x".to_string(), json!(jwk.x));
    map.insert("y".to_string(), json!(jwk.y));
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(
        serde_json::to_string(&Value::Object(map))?.as_bytes(),
    )))
}

fn decode_base64url(value: &str) -> Result<Vec<u8>> {
    Ok(URL_SAFE_NO_PAD.decode(value)?)
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    time::OffsetDateTime::from_unix_timestamp(now.as_secs() as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}
