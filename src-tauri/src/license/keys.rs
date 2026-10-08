//! Public keys KADRA trusts, by `kid` (3.3).
//!
//! The list is compiled in from `license-keys.json` next to Cargo.toml.
//! Rotating a key means adding the new `kid` there in version N and signing
//! with it from version N+1; revoking one means shipping a build without it.
//!
//! The `dev` key, whose private half is committed under tools/kdr-license/dev,
//! is added only to debug builds. A release build does not contain it at all,
//! so a licence signed with it is INVALID there (test 2).

use std::collections::BTreeMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;

const RELEASE_KEYS: &str = include_str!("../../license-keys.json");
#[cfg(debug_assertions)]
const DEV_KEYS: &str = include_str!("../../license-keys.dev.json");

pub const DEV_KID: &str = "dev";

#[derive(Clone, Default)]
pub struct KeyRing {
    keys: BTreeMap<String, VerifyingKey>,
}

impl KeyRing {
    /// What this build trusts.
    pub fn embedded() -> Self {
        #[allow(unused_mut)]
        let mut ring = Self::release();
        #[cfg(debug_assertions)]
        ring.extend(parse(DEV_KEYS, "license-keys.dev.json"));
        ring
    }

    /// The release list alone, without the dev key.
    pub fn release() -> Self {
        let mut ring = Self::default();
        ring.extend(parse(RELEASE_KEYS, "license-keys.json"));
        // The release list must never carry the dev key, whatever the file says.
        ring.keys.remove(DEV_KID);
        ring
    }

    #[cfg(test)]
    pub fn with(kid: &str, key: VerifyingKey) -> Self {
        let mut ring = Self::default();
        ring.keys.insert(kid.to_string(), key);
        ring
    }

    fn extend(&mut self, keys: BTreeMap<String, VerifyingKey>) {
        self.keys.extend(keys);
    }

    pub fn get(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys.get(kid)
    }

    #[allow(dead_code)]
    pub fn kids(&self) -> impl Iterator<Item = &str> {
        self.keys.keys().map(String::as_str)
    }
}

/// A malformed key file is a build defect, not a runtime condition: every
/// licence would silently turn INVALID. Tests catch it before release.
fn parse(json: &str, name: &str) -> BTreeMap<String, VerifyingKey> {
    let raw: BTreeMap<String, String> =
        serde_json::from_str(json).unwrap_or_else(|e| panic!("{name}: {e}"));
    raw.into_iter()
        .map(|(kid, encoded)| {
            let bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(encoded.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .unwrap_or_else(|| panic!("{name}: key {kid} is not 32 bytes of base64url"));
            let key = VerifyingKey::from_bytes(&bytes)
                .unwrap_or_else(|e| panic!("{name}: key {kid}: {e}"));
            (kid, key)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_files_parse() {
        let _ = KeyRing::embedded();
    }

    // Test 2, second half: the release list has no dev key.
    #[test]
    fn release_ring_never_contains_the_dev_key() {
        assert!(KeyRing::release().get(DEV_KID).is_none());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_ring_contains_the_dev_key() {
        assert!(KeyRing::embedded().get(DEV_KID).is_some());
    }
}
