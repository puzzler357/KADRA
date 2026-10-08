//! What licensing needs from the operating system, behind one trait so the
//! acceptance tests can substitute time, hardware and storage (13: "с подменой
//! текущего времени и отпечатка").

use chrono::{DateTime, Utc};

#[cfg(windows)]
use super::fingerprint;
use super::model::Fingerprint;

pub trait Platform: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    fn fingerprint(&self) -> Fingerprint;
    fn device_name(&self) -> String;

    /// DPAPI: bound to this Windows user on this machine.
    fn protect(&self, data: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, data: &[u8]) -> Result<Vec<u8>, String>;

    /// The protected vault in HKCU\Software\KADRA\License.
    fn vault_read(&self) -> Option<Vec<u8>>;
    fn vault_write(&self, data: &[u8]) -> Result<(), String>;
}

#[cfg(not(windows))]
pub use other_platform::OtherPlatform as SystemPlatform;
#[cfg(windows)]
pub use windows_platform::WindowsPlatform as SystemPlatform;

#[cfg(windows)]
mod windows_platform {
    use super::*;
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::{RegKey, RegValue};

    const VAULT_KEY: &str = r"Software\KADRA\License";
    const VAULT_VALUE: &str = "Vault";

    #[derive(Default)]
    pub struct WindowsPlatform {
        fingerprint: OnceLock<Fingerprint>,
    }

    impl Platform for WindowsPlatform {
        fn now(&self) -> DateTime<Utc> {
            Utc::now()
        }

        /// Read once per run: the WMI queries take a noticeable fraction of a
        /// second, and the hardware does not change under a running process.
        fn fingerprint(&self) -> Fingerprint {
            self.fingerprint
                .get_or_init(|| fingerprint::from_raw(&fingerprint::windows::read()))
                .clone()
        }

        fn device_name(&self) -> String {
            std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into())
        }

        fn protect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
            dpapi(data, true)
        }

        fn unprotect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
            dpapi(data, false)
        }

        fn vault_read(&self) -> Option<Vec<u8>> {
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(VAULT_KEY)
                .and_then(|key| key.get_raw_value(VAULT_VALUE))
                .map(|value| value.bytes)
                .ok()
        }

        fn vault_write(&self, data: &[u8]) -> Result<(), String> {
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(VAULT_KEY)
                .map_err(|e| e.to_string())?;
            key.set_raw_value(
                VAULT_VALUE,
                &RegValue {
                    bytes: data.to_vec(),
                    vtype: winreg::enums::RegType::REG_BINARY,
                },
            )
            .map_err(|e| e.to_string())
        }
    }

    fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input points at `data` for the duration of the call; the
        // output buffer is allocated by the API and released with LocalFree
        // after it is copied out.
        unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    PCWSTR::null(),
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    None,
                    None,
                    None,
                    None,
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
            .map_err(|e| e.to_string())?;
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
            Ok(bytes)
        }
    }
}

#[cfg(not(windows))]
mod other_platform {
    //! Licensing is specified for Windows only (4.1). Elsewhere nothing can be
    //! bound to the machine, so activation fails and the app stays READ_ONLY.
    use super::*;

    #[derive(Default)]
    pub struct OtherPlatform;

    impl Platform for OtherPlatform {
        fn now(&self) -> DateTime<Utc> {
            Utc::now()
        }
        fn fingerprint(&self) -> Fingerprint {
            Fingerprint::default()
        }
        fn device_name(&self) -> String {
            "device".into()
        }
        fn protect(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("licensing is supported on Windows only".into())
        }
        fn unprotect(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err("licensing is supported on Windows only".into())
        }
        fn vault_read(&self) -> Option<Vec<u8>> {
            None
        }
        fn vault_write(&self, _: &[u8]) -> Result<(), String> {
            Err("licensing is supported on Windows only".into())
        }
    }
}

#[cfg(test)]
pub mod fake {
    //! A machine the tests control: its clock, its hardware and its storage.
    //! "DPAPI" here binds to the machine's identity, so moving the vault to a
    //! FakeMachine with another identity fails to decrypt, as it would for real.
    use super::*;
    use std::sync::Mutex;

    pub struct FakeMachine {
        pub now: Mutex<DateTime<Utc>>,
        pub fp: Mutex<Fingerprint>,
        pub identity: u8,
        pub vault: Mutex<Option<Vec<u8>>>,
    }

    impl FakeMachine {
        pub fn new(now: DateTime<Utc>, identity: u8) -> Self {
            let tag = |c: &str| format!("{c}-{identity}");
            Self {
                now: Mutex::new(now),
                fp: Mutex::new(Fingerprint {
                    mg: tag("mg"),
                    smbios: tag("smbios"),
                    disk: tag("disk"),
                }),
                identity,
                vault: Mutex::new(None),
            }
        }

        pub fn set_now(&self, now: DateTime<Utc>) {
            *self.now.lock().unwrap() = now;
        }

        pub fn advance(&self, by: chrono::Duration) {
            let mut now = self.now.lock().unwrap();
            *now += by;
        }
    }

    impl Platform for FakeMachine {
        fn now(&self) -> DateTime<Utc> {
            *self.now.lock().unwrap()
        }
        fn fingerprint(&self) -> Fingerprint {
            self.fp.lock().unwrap().clone()
        }
        fn device_name(&self) -> String {
            format!("PC-{}", self.identity)
        }
        fn protect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = vec![self.identity];
            out.extend(data.iter().map(|b| b ^ self.identity));
            Ok(out)
        }
        fn unprotect(&self, data: &[u8]) -> Result<Vec<u8>, String> {
            match data.split_first() {
                Some((&id, rest)) if id == self.identity => {
                    Ok(rest.iter().map(|b| b ^ self.identity).collect())
                }
                _ => Err("DPAPI: key not valid for use in specified state".into()),
            }
        }
        fn vault_read(&self) -> Option<Vec<u8>> {
            self.vault.lock().unwrap().clone()
        }
        fn vault_write(&self, data: &[u8]) -> Result<(), String> {
            *self.vault.lock().unwrap() = Some(data.to_vec());
            Ok(())
        }
    }
}
