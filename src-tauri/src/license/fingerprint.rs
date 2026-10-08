//! Device fingerprint (4.1): three components, each stored only as
//! `SHA-256("KDR-fp-v1" + value)`. The raw values never leave the machine.
//!
//! It is recomputed on every start and never cached on disk: a stored
//! identifier would simply be copied along with everything else.

// Read only on Windows (platform.rs); elsewhere licensing binds to nothing.
#![cfg_attr(not(windows), allow(dead_code))]

use sha2::{Digest, Sha256};

use super::model::Fingerprint;

/// Raw component values as read from the machine; `None` when unreadable.
#[derive(Debug, Clone, Default)]
pub struct RawComponents {
    pub machine_guid: Option<String>,
    pub smbios_uuid: Option<String>,
    pub disk_serial: Option<String>,
}

pub fn hash_component(value: Option<&str>) -> String {
    let Some(value) = value.map(normalize).filter(|v| !is_placeholder(v)) else {
        return String::new();
    };
    let mut hasher = Sha256::new();
    hasher.update(b"KDR-fp-v1");
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn from_raw(raw: &RawComponents) -> Fingerprint {
    Fingerprint {
        mg: hash_component(raw.machine_guid.as_deref()),
        smbios: hash_component(raw.smbios_uuid.as_deref()),
        disk: hash_component(raw.disk_serial.as_deref()),
    }
}

/// Case and padding vary between the APIs that report the same value (disk
/// serials come space-padded from some drivers).
fn normalize(value: &str) -> String {
    value.trim().to_uppercase()
}

/// Values some firmware reports instead of a real identifier. Hashing them
/// would make every such board "match" every other.
fn is_placeholder(value: &str) -> bool {
    value.is_empty()
        || value.chars().all(|c| c == '0' || c == '-')
        || value.chars().all(|c| c == 'F' || c == '-')
        || value == "TO BE FILLED BY O.E.M."
        || value == "DEFAULT STRING"
}

#[cfg(windows)]
pub mod windows {
    //! Reading the components on Windows.
    use super::RawComponents;
    use serde::Deserialize;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    pub fn read() -> RawComponents {
        let machine_guid = RegKey::predef(HKEY_LOCAL_MACHINE)
            // 64-bit view: a 32-bit process would otherwise read the WOW6432
            // copy, which does not carry MachineGuid.
            .open_subkey_with_flags(
                r"SOFTWARE\Microsoft\Cryptography",
                KEY_READ | KEY_WOW64_64KEY,
            )
            .and_then(|key| key.get_value::<String, _>("MachineGuid"))
            .ok();

        // COM is initialised per thread, and the window's thread is already
        // single-threaded for WebView2. WMI gets a thread of its own.
        let (smbios_uuid, disk_serial) =
            std::thread::spawn(read_wmi).join().unwrap_or((None, None));

        RawComponents {
            machine_guid,
            smbios_uuid,
            disk_serial,
        }
    }

    #[derive(Deserialize)]
    #[serde(rename = "Win32_ComputerSystemProduct", rename_all = "PascalCase")]
    struct Product {
        #[serde(rename = "UUID")]
        uuid: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Partition {
        #[serde(rename = "DeviceID")]
        device_id: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Drive {
        serial_number: Option<String>,
    }

    fn read_wmi() -> (Option<String>, Option<String>) {
        let Ok(connection) = wmi::WMIConnection::new(match wmi::COMLibrary::new() {
            Ok(com) => com,
            Err(_) => return (None, None),
        }) else {
            return (None, None);
        };

        let uuid = connection
            .raw_query::<Product>("SELECT UUID FROM Win32_ComputerSystemProduct")
            .ok()
            .and_then(|rows| rows.into_iter().find_map(|row| row.uuid));

        (uuid, system_disk_serial(&connection))
    }

    /// The physical drive holding the Windows volume - not the volume serial,
    /// which a reinstall reformats and changes together with MachineGuid,
    /// turning a same-machine reinstall into a different machine.
    fn system_disk_serial(connection: &wmi::WMIConnection) -> Option<String> {
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let partitions: Vec<Partition> = connection
            .raw_query(format!(
                "ASSOCIATORS OF {{Win32_LogicalDisk.DeviceID='{system_drive}'}} \
                 WHERE AssocClass=Win32_LogicalDiskToPartition"
            ))
            .ok()?;
        let partition = partitions.into_iter().next()?;
        let drives: Vec<Drive> = connection
            .raw_query(format!(
                "ASSOCIATORS OF {{Win32_DiskPartition.DeviceID='{}'}} \
                 WHERE AssocClass=Win32_DiskDriveToDiskPartition",
                partition.device_id
            ))
            .ok()?;
        drives.into_iter().find_map(|drive| drive.serial_number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_is_stable_across_case_and_padding() {
        assert_eq!(
            hash_component(Some(" abc-1 ")),
            hash_component(Some("ABC-1"))
        );
        assert_eq!(hash_component(Some("abc")).len(), 64);
    }

    #[test]
    fn placeholders_and_missing_values_hash_to_nothing() {
        for value in [
            None,
            Some(""),
            Some("00000000-0000-0000-0000-000000000000"),
            Some("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"),
            Some("To be filled by O.E.M."),
        ] {
            assert_eq!(hash_component(value), "");
        }
    }

    #[test]
    fn empty_components_never_match() {
        let a = Fingerprint {
            mg: "1".into(),
            smbios: String::new(),
            disk: String::new(),
        };
        assert_eq!(a.matches(&a.clone()), 1);
    }

    /// Prints what this machine reports; run by hand to see the real readers.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn read_this_machine() {
        let raw = windows::read();
        println!("mg: {}", raw.machine_guid.is_some());
        println!("smbios: {}", raw.smbios_uuid.is_some());
        println!("disk: {}", raw.disk_serial.is_some());
        let fp = from_raw(&raw);
        assert!(
            fp.matches(&fp.clone()) >= 2,
            "fewer than two readable components"
        );
    }
}
