//! Opening a signed envelope (3.1): `kid` → signature over the payload bytes →
//! only then JSON.
//!
//! The order matters. Parsing before verifying would mean running a JSON
//! parser over attacker-controlled input and, worse, tempt code to act on a
//! field before the signature was known to be good.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::Signature;
use serde_json::Value;

use super::keys::KeyRing;
use super::model::{Envelope, LicensePayload, SignedStatus};

pub const PRODUCT: &str = "HRDESK";
pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    Format(String),
    UnknownKid(String),
    BadSignature,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Format(reason) => write!(f, "malformed licence file: {reason}"),
            VerifyError::UnknownKid(kid) => write!(f, "unknown signing key \"{kid}\""),
            VerifyError::BadSignature => write!(f, "signature does not match"),
        }
    }
}

/// Everything a signed file can carry.
#[derive(Debug, Clone)]
pub enum Signed {
    License(LicensePayload),
    Status(SignedStatus),
}

/// Checks the signature and returns the payload bytes it covers.
pub fn open_envelope(bytes: &[u8], ring: &KeyRing) -> Result<Vec<u8>, VerifyError> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|e| VerifyError::Format(e.to_string()))?;

    let key = ring
        .get(&envelope.kid)
        .ok_or_else(|| VerifyError::UnknownKid(envelope.kid.clone()))?;

    let payload = URL_SAFE_NO_PAD
        .decode(envelope.payload.trim())
        .map_err(|_| VerifyError::Format("payload is not base64url".into()))?;
    let signature: [u8; 64] = URL_SAFE_NO_PAD
        .decode(envelope.sig.trim())
        .ok()
        .and_then(|sig| sig.try_into().ok())
        .ok_or_else(|| VerifyError::Format("signature is not 64 bytes of base64url".into()))?;

    key.verify_strict(&payload, &Signature::from_bytes(&signature))
        .map_err(|_| VerifyError::BadSignature)?;

    Ok(payload)
}

/// A licence or a status, told apart by the `kind` field only statuses have.
pub fn verify(bytes: &[u8], ring: &KeyRing) -> Result<Signed, VerifyError> {
    let payload = open_envelope(bytes, ring)?;
    let value: Value =
        serde_json::from_slice(&payload).map_err(|e| VerifyError::Format(e.to_string()))?;

    if value.get("v").and_then(Value::as_u64) != Some(u64::from(FORMAT_VERSION)) {
        return Err(VerifyError::Format("unsupported format version".into()));
    }

    if value.get("kind").is_some() {
        let status: SignedStatus =
            serde_json::from_value(value).map_err(|e| VerifyError::Format(e.to_string()))?;
        return Ok(Signed::Status(status));
    }

    let license: LicensePayload =
        serde_json::from_value(value).map_err(|e| VerifyError::Format(e.to_string()))?;
    if license.product != PRODUCT {
        return Err(VerifyError::Format(format!(
            "licence is for {}",
            license.product
        )));
    }
    Ok(Signed::License(license))
}

pub fn verify_license(bytes: &[u8], ring: &KeyRing) -> Result<LicensePayload, VerifyError> {
    match verify(bytes, ring)? {
        Signed::License(license) => Ok(license),
        Signed::Status(_) => Err(VerifyError::Format("a status, not a licence".into())),
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! Signing helpers the tests share: the same envelope the utility writes.
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    pub fn seal(kid: &str, key: &SigningKey, payload: &[u8]) -> Vec<u8> {
        let envelope = Envelope {
            kid: kid.into(),
            payload: URL_SAFE_NO_PAD.encode(payload),
            sig: URL_SAFE_NO_PAD.encode(key.sign(payload).to_bytes()),
        };
        serde_json::to_vec(&envelope).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::license::keys::{KeyRing, DEV_KID};

    const LICENSE: &str = r#"{"v":1,"license_id":"HRD-2026-000001","revision":1,
        "customer_id":"C1","customer_name":"ABC","product":"HRDESK","plan":"ANNUAL",
        "activation_mode":"OFFLINE","seats":1,
        "activation":{"activation_id":"ACT-1","device_name":"PC","device_pubkey":"x",
          "fp":{"mg":"a","smbios":"b","disk":"c"},"fp_threshold":2},
        "issued_at":"2026-09-27T16:00:00Z","paid_until":"2027-09-27T23:59:59Z",
        "grace_days":7,"lease_until":"2027-10-04T23:59:59Z","max_version":"1.99.99"}"#;

    #[test]
    fn a_good_envelope_verifies() {
        let key = signing_key(1);
        let ring = KeyRing::with("k1", key.verifying_key());
        let license = verify_license(&seal("k1", &key, LICENSE.as_bytes()), &ring).unwrap();
        assert_eq!(license.license_id, "HRD-2026-000001");
    }

    // Test 1: one byte changed in the payload.
    #[test]
    fn one_changed_byte_breaks_the_signature() {
        let key = signing_key(1);
        let ring = KeyRing::with("k1", key.verifying_key());
        let mut envelope: Envelope =
            serde_json::from_slice(&seal("k1", &key, LICENSE.as_bytes())).unwrap();
        let mut payload = URL_SAFE_NO_PAD.decode(&envelope.payload).unwrap();
        // A space: still valid JSON, so only the signature can catch it.
        payload.insert(1, b' ');
        envelope.payload = URL_SAFE_NO_PAD.encode(payload);

        let result = verify_license(&serde_json::to_vec(&envelope).unwrap(), &ring);
        assert_eq!(result.unwrap_err(), VerifyError::BadSignature);
    }

    // Test 2: unknown kid, and the dev key against the release list.
    #[test]
    fn unknown_kid_and_dev_key_in_release_are_rejected() {
        let key = signing_key(1);
        let ring = KeyRing::with("k1", key.verifying_key());
        assert!(matches!(
            verify_license(&seal("k2", &key, LICENSE.as_bytes()), &ring),
            Err(VerifyError::UnknownKid(_))
        ));
        assert!(matches!(
            verify_license(
                &seal(DEV_KID, &key, LICENSE.as_bytes()),
                &KeyRing::release()
            ),
            Err(VerifyError::UnknownKid(_))
        ));
    }

    #[test]
    fn a_signature_by_another_key_is_rejected() {
        let ring = KeyRing::with("k1", signing_key(1).verifying_key());
        let forged = seal("k1", &signing_key(2), LICENSE.as_bytes());
        assert_eq!(
            verify_license(&forged, &ring).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    #[test]
    fn other_products_and_versions_are_rejected() {
        let key = signing_key(1);
        let ring = KeyRing::with("k1", key.verifying_key());
        let other = LICENSE.replace("\"product\":\"HRDESK\"", "\"product\":\"XYZ\"");
        assert!(verify_license(&seal("k1", &key, other.as_bytes()), &ring).is_err());
        let v2 = LICENSE.replacen("\"v\":1", "\"v\":2", 1);
        assert!(verify_license(&seal("k1", &key, v2.as_bytes()), &ring).is_err());
    }

    /// A file the Node utility wrote with the dev key: the two sides must
    /// agree on the envelope byte for byte.
    #[cfg(debug_assertions)]
    #[test]
    fn a_file_signed_by_the_utility_verifies() {
        let bytes = include_bytes!("../../tests/fixtures/utility-signed.hrdlic");
        let license = verify_license(bytes, &KeyRing::embedded()).unwrap();
        assert_eq!(license.product, "HRDESK");
    }
}
