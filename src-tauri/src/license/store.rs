//! Where licensing keeps its data (9.1): the licence file and `state.bin`
//! under `%APPDATA%\com.kadra.local\license\`, and a DPAPI-protected vault
//! in `HKCU\Software\KADRA\License`.
//!
//! The vault holds the device key, the HMAC key for `state.bin`, and the
//! second copy of the state (6). Keeping the key and the state copy in one
//! protected value is deliberate: the state cannot be deleted without the
//! device key going with it, and a missing device key means REBIND_REQUIRED -
//! a new file from the vendor. So wiping local storage to reset the clock
//! anchor (the bypass 6.2 describes) buys nothing but a call to the seller.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::device_key::{random_key, DeviceKey};
use super::model::PersistedState;
use super::platform::Platform;

pub const LICENSE_FILE: &str = "license.kdrlic";
pub const STATE_FILE: &str = "state.bin";

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Deserialize)]
struct VaultData {
    v: u32,
    mac_key: String,
    #[serde(default)]
    device_secret: Option<String>,
    state: PersistedState,
}

/// Everything the vault protects, decrypted.
pub struct Stored {
    pub device: Option<DeviceKey>,
    pub state: PersistedState,
    mac_key: [u8; 32],
}

impl Stored {
    pub fn fresh(now: DateTime<Utc>) -> Self {
        Self {
            device: None,
            state: PersistedState::new(now),
            mac_key: random_key(),
        }
    }
}

pub struct Store {
    dir: PathBuf,
    platform: Arc<dyn Platform>,
}

impl Store {
    pub fn new(dir: PathBuf, platform: Arc<dyn Platform>) -> Self {
        Self { dir, platform }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// The vault and the file copy, merged. `None` when there is no vault or
    /// it cannot be decrypted here - a copy from another machine or profile.
    pub fn load(&self) -> Option<Stored> {
        let sealed = self.platform.vault_read()?;
        let plain = self.platform.unprotect(&sealed).ok()?;
        let vault: VaultData = serde_json::from_slice(&plain).ok()?;

        let mac_key: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&vault.mac_key)
            .ok()?
            .try_into()
            .ok()?;
        let device = vault
            .device_secret
            .as_deref()
            .and_then(|secret| URL_SAFE_NO_PAD.decode(secret).ok())
            .and_then(|secret| DeviceKey::from_secret(&secret));

        let mut state = vault.state;
        if let Some(file_state) = self.read_state_file(&mac_key) {
            state = state.merge(file_state);
        }

        Some(Stored {
            device,
            state,
            mac_key,
        })
    }

    fn read_state_file(&self, mac_key: &[u8; 32]) -> Option<PersistedState> {
        let bytes = fs::read(self.path(STATE_FILE)).ok()?;
        if bytes.len() < 32 {
            return None;
        }
        let (tag, body) = bytes.split_at(32);
        let mut mac = HmacSha256::new_from_slice(mac_key).ok()?;
        mac.update(body);
        mac.verify_slice(tag).ok()?;
        serde_json::from_slice(body).ok()
    }

    /// Writes both copies. The vault first: it is the one that carries the
    /// device key, and a state file without its vault is unreadable anyway.
    pub fn save(&self, stored: &Stored) -> Result<(), String> {
        let vault = VaultData {
            v: 1,
            mac_key: URL_SAFE_NO_PAD.encode(stored.mac_key),
            device_secret: stored
                .device
                .as_ref()
                .map(|d| URL_SAFE_NO_PAD.encode(d.secret())),
            state: stored.state.clone(),
        };
        let plain = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;
        let sealed = self.platform.protect(&plain)?;
        self.platform.vault_write(&sealed)?;

        let body = serde_json::to_vec(&stored.state).map_err(|e| e.to_string())?;
        let mut mac = HmacSha256::new_from_slice(&stored.mac_key).map_err(|e| e.to_string())?;
        mac.update(&body);
        let mut file = mac.finalize().into_bytes().to_vec();
        file.extend_from_slice(&body);
        self.write(STATE_FILE, &file)
    }

    pub fn license_bytes(&self) -> Option<Vec<u8>> {
        fs::read(self.path(LICENSE_FILE)).ok()
    }

    pub fn write_license(&self, bytes: &[u8]) -> Result<(), String> {
        self.write(LICENSE_FILE, bytes)
    }

    pub fn remove_license(&self) -> Result<(), String> {
        match fs::remove_file(self.path(LICENSE_FILE)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// Write-then-rename, so a crash mid-write leaves the old file whole.
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let target = self.path(name);
        let temporary = self.path(&format!("{name}.tmp"));
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &target).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn state_file(&self) -> PathBuf {
        self.path(STATE_FILE)
    }
}
