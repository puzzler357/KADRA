//! The device key (4.1): an Ed25519 pair made at first activation. Its public
//! half goes into the licence; its private half stays in the DPAPI-protected
//! vault, so a copy of the profile on another machine cannot use it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;

use super::model::{RequestPayload, SignedRequest};

pub struct DeviceKey {
    signing: SigningKey,
}

impl DeviceKey {
    pub fn generate() -> Self {
        Self {
            signing: SigningKey::generate(&mut OsRng),
        }
    }

    pub fn from_secret(secret: &[u8]) -> Option<Self> {
        let bytes: [u8; 32] = secret.try_into().ok()?;
        Some(Self {
            signing: SigningKey::from_bytes(&bytes),
        })
    }

    pub fn secret(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    pub fn public_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing.verifying_key().to_bytes())
    }

    pub fn sign_request(&self, payload: &RequestPayload) -> SignedRequest {
        let bytes = serde_json::to_vec(payload).expect("request serialises");
        SignedRequest {
            device_sig: URL_SAFE_NO_PAD.encode(self.signing.sign(&bytes).to_bytes()),
            payload: URL_SAFE_NO_PAD.encode(bytes),
        }
    }
}

/// Checks a request against the key it names. The utility and the server do
/// the same; kept here so the tests can prove the two ends agree.
#[allow(dead_code)]
pub fn verify_request(request: &SignedRequest) -> Option<RequestPayload> {
    let bytes = URL_SAFE_NO_PAD.decode(&request.payload).ok()?;
    let payload: RequestPayload = serde_json::from_slice(&bytes).ok()?;
    let key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&payload.device_pubkey)
        .ok()?
        .try_into()
        .ok()?;
    let sig: [u8; 64] = URL_SAFE_NO_PAD
        .decode(&request.device_sig)
        .ok()?
        .try_into()
        .ok()?;
    VerifyingKey::from_bytes(&key)
        .ok()?
        .verify(&bytes, &Signature::from_bytes(&sig))
        .ok()?;
    Some(payload)
}

/// 16 random bytes, base64url (5.1).
pub fn nonce() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_key() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
}
