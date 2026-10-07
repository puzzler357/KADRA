//! Wire formats (LICENSING.md 3.1, 3.2, 3.4, 5.1) and the state kept on
//! disk between runs.
//!
//! Unknown fields are ignored on purpose: a newer License Manager may add
//! fields that an older HRDesk does not know, and the signature already
//! guarantees nobody else added them.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Signed container shared by licences, statuses and clock resets (3.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub kid: String,
    /// base64url of the payload bytes; the signature covers these bytes.
    pub payload: String,
    pub sig: String,
}

/// One hash per component (4.1). An empty string means the component could
/// not be read on that machine; it never counts as a match.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    #[serde(default)]
    pub mg: String,
    #[serde(default)]
    pub smbios: String,
    #[serde(default)]
    pub disk: String,
}

impl Fingerprint {
    pub fn matches(&self, other: &Fingerprint) -> u8 {
        [
            (&self.mg, &other.mg),
            (&self.smbios, &other.smbios),
            (&self.disk, &other.disk),
        ]
        .iter()
        .filter(|(a, b)| !a.is_empty() && a == b)
        .count() as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Plan {
    Perpetual,
    Annual,
    Quarterly,
    Monthly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActivationMode {
    Online,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activation {
    pub activation_id: String,
    pub device_name: String,
    pub device_pubkey: String,
    pub fp: Fingerprint,
    #[serde(default = "default_fp_threshold")]
    pub fp_threshold: u8,
}

fn default_fp_threshold() -> u8 {
    2
}

/// The licence proper (3.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicensePayload {
    pub v: u32,
    pub license_id: String,
    pub revision: u64,
    pub customer_id: String,
    pub customer_name: String,
    pub product: String,
    #[serde(default)]
    pub edition: String,
    #[serde(default)]
    pub features: Vec<String>,
    pub plan: Plan,
    pub activation_mode: ActivationMode,
    #[serde(default = "default_seats")]
    pub seats: u32,
    pub activation: Activation,
    pub issued_at: DateTime<Utc>,
    pub paid_until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub grace_days: u32,
    pub lease_until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub refresh_after: Option<DateTime<Utc>>,
    #[serde(default)]
    pub max_version: Option<String>,
    /// Overrides the built-in server address (5.2); signed like the rest.
    #[serde(default)]
    pub server_url: Option<String>,
}

fn default_seats() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StatusKind {
    Revoked,
    Transferred,
    ClockReset,
}

/// A signed status or unlock (3.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedStatus {
    pub v: u32,
    pub kind: StatusKind,
    pub license_id: String,
    pub activation_id: String,
    pub revision: u64,
    #[serde(default)]
    pub nonce: Option<String>,
    pub issued_at: DateTime<Utc>,
    #[serde(default)]
    pub high_water_to: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RequestType {
    Activate,
    Refresh,
    Rebind,
    Deactivate,
}

/// What the device asks for (5.1). The same JSON goes over HTTPS or into a
/// `.hrdreq` file; a `.hrddeact` proof is a DEACTIVATE request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPayload {
    #[serde(rename = "type")]
    pub kind: RequestType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<u64>,
    pub device_name: String,
    pub device_pubkey: String,
    pub fp: Fingerprint,
    pub app_version: String,
    pub client_time: DateTime<Utc>,
    pub counter: u64,
    pub nonce: String,
}

/// A request signed with the device key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedRequest {
    pub payload: String,
    pub device_sig: String,
}

/// Where the installed licence stands with this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub license_id: String,
    pub activation_id: String,
    /// Highest revision seen for this activation, from a file or a status.
    pub max_revision: u64,
    /// Revision of an accepted signed REVOKED; survives restarts (3.4).
    #[serde(default)]
    pub revoked: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deactivated {
    pub license_id: String,
    pub activation_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anomaly {
    pub at: DateTime<Utc>,
    pub kind: String,
    pub detail: String,
}

/// Kept in two copies, state.bin and the registry vault (6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedState {
    pub v: u32,
    /// Latest time this device is known to have seen (6).
    pub high_water: DateTime<Utc>,
    /// Monotonic request counter (5.1).
    #[serde(default)]
    pub counter: u64,
    #[serde(default)]
    pub track: Option<Track>,
    #[serde(default)]
    pub deactivated: Option<Deactivated>,
    /// The anomaly journal of 6.1, newest last, capped.
    #[serde(default)]
    pub anomalies: Vec<Anomaly>,
    /// Last successful exchange with the licence server (stage 4).
    #[serde(default)]
    pub last_check: Option<DateTime<Utc>>,
}

pub const MAX_ANOMALIES: usize = 50;

impl PersistedState {
    pub fn new(now: DateTime<Utc>) -> Self {
        Self {
            v: 1,
            high_water: now,
            counter: 0,
            track: None,
            deactivated: None,
            anomalies: Vec::new(),
            last_check: None,
        }
    }

    pub fn record_anomaly(&mut self, at: DateTime<Utc>, kind: &str, detail: String) {
        eprintln!("[License] anomaly {kind}: {detail}");
        self.anomalies.push(Anomaly {
            at,
            kind: kind.to_string(),
            detail,
        });
        let excess = self.anomalies.len().saturating_sub(MAX_ANOMALIES);
        self.anomalies.drain(..excess);
    }

    /// Combines the two copies so that deleting or rolling back one of them
    /// gains nothing: every monotonic value takes the larger side.
    pub fn merge(mut self, other: PersistedState) -> PersistedState {
        self.high_water = self.high_water.max(other.high_water);
        self.counter = self.counter.max(other.counter);
        self.last_check = self.last_check.max(other.last_check);

        self.track = match (self.track.take(), other.track) {
            (Some(a), Some(b))
                if a.license_id == b.license_id && a.activation_id == b.activation_id =>
            {
                Some(Track {
                    max_revision: a.max_revision.max(b.max_revision),
                    revoked: a.revoked.max(b.revoked),
                    ..a
                })
            }
            (Some(a), Some(b)) => Some(if b.max_revision > a.max_revision {
                b
            } else {
                a
            }),
            (a, b) => a.or(b),
        };

        if self.deactivated.is_none() {
            self.deactivated = other.deactivated;
        }
        for anomaly in other.anomalies {
            if !self.anomalies.contains(&anomaly) {
                self.anomalies.push(anomaly);
            }
        }
        self.anomalies.sort_by_key(|a| a.at);
        let excess = self.anomalies.len().saturating_sub(MAX_ANOMALIES);
        self.anomalies.drain(..excess);
        self
    }
}
