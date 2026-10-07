//! The licence state, computed in the order of 8.1, and the app mode it
//! implies (8.2).
//!
//! A pure function of its inputs, so every acceptance test can drive it with
//! a substituted clock and fingerprint.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use super::clock;
use super::model::{ActivationMode, Fingerprint, LicensePayload, PersistedState};
use super::verify::VerifyError;
use crate::db::guard::Mode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Unlicensed,
    Invalid,
    MachineMismatch,
    RebindRequired,
    StateMissing,
    VersionNotCovered,
    ClockRollback,
    Revoked,
    Expired,
    LeaseExpired,
    Grace,
    Active,
}

impl Status {
    /// FULL only while paid for and trusted; everything else reads only.
    pub fn mode(self) -> Mode {
        match self {
            Status::Active | Status::Grace => Mode::Full,
            _ => Mode::ReadOnly,
        }
    }
}

pub struct Inputs<'a> {
    /// `None`: no licence file. `Some(Err)`: present but not valid.
    pub license: Option<&'a Result<LicensePayload, VerifyError>>,
    pub fingerprint: &'a Fingerprint,
    pub device_pubkey: Option<String>,
    pub state: Option<&'a PersistedState>,
    pub now: DateTime<Utc>,
    pub app_version: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub status: Status,
    /// Machine-readable detail for the UI and the logs.
    pub reason: Option<String>,
}

fn is(status: Status) -> Evaluation {
    Evaluation {
        status,
        reason: None,
    }
}

fn because(status: Status, reason: impl Into<String>) -> Evaluation {
    Evaluation {
        status,
        reason: Some(reason.into()),
    }
}

pub fn evaluate(input: &Inputs) -> Evaluation {
    // 1
    let Some(license) = input.license else {
        return is(Status::Unlicensed);
    };
    // 2
    let license = match license {
        Ok(license) => license,
        Err(error) => return because(Status::Invalid, error.to_string()),
    };
    // 3
    let threshold = license.activation.fp_threshold.max(1);
    if input.fingerprint.matches(&license.activation.fp) < threshold {
        return is(Status::MachineMismatch);
    }
    // 4
    match &input.device_pubkey {
        None => return because(Status::RebindRequired, "DEVICE_KEY_MISSING"),
        Some(key) if *key != license.activation.device_pubkey => {
            return because(Status::RebindRequired, "DEVICE_KEY_MISMATCH")
        }
        Some(_) => {}
    }
    // 5 (6.2): the state must exist and belong to this activation. OFFLINE
    // has nothing to refresh from, so it needs a new file: REBIND_REQUIRED.
    let state = input.state.filter(|state| {
        state.track.as_ref().is_some_and(|track| {
            track.license_id == license.license_id
                && track.activation_id == license.activation.activation_id
        })
    });
    let Some(state) = state else {
        return match license.activation_mode {
            ActivationMode::Offline => because(Status::RebindRequired, "STATE_MISSING"),
            ActivationMode::Online => is(Status::StateMissing),
        };
    };
    let track = state.track.as_ref().expect("filtered above");
    // 6
    if let Some(max) = &license.max_version {
        if !version_covered(input.app_version, max) {
            return because(
                Status::VersionNotCovered,
                format!("{} > {max}", input.app_version),
            );
        }
    }
    // 7
    let high_water = state.high_water.max(license.issued_at);
    if clock::is_rollback(input.now, high_water, license.issued_at) {
        return is(Status::ClockRollback);
    }
    // 8
    if track.revoked.is_some() {
        return is(Status::Revoked);
    }
    // 9, 10, 11: 9 and 10 apart on purpose - pay, or reconnect.
    let paid_end = license
        .paid_until
        .map(|paid| paid + Duration::days(i64::from(license.grace_days)));
    if paid_end.is_some_and(|end| input.now > end) {
        return is(Status::Expired);
    }
    if license.lease_until.is_some_and(|lease| input.now > lease) {
        return is(Status::LeaseExpired);
    }
    if license.paid_until.is_some_and(|paid| input.now > paid) {
        return is(Status::Grace);
    }
    // 12
    is(Status::Active)
}

/// `app <= max` over dotted numeric versions; anything unparsable is not
/// covered, since the file is signed and a bad value is the vendor's error.
pub fn version_covered(app: &str, max: &str) -> bool {
    fn parse(version: &str) -> Option<Vec<u64>> {
        version
            .trim()
            .split('.')
            .map(|part| part.parse().ok())
            .collect()
    }
    match (parse(app), parse(max)) {
        (Some(mut app), Some(mut max)) => {
            let len = app.len().max(max.len());
            app.resize(len, 0);
            max.resize(len, 0);
            app <= max
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(version_covered("1.0.0", "1.99.99"));
        assert!(version_covered("1.10.0", "1.99.99"));
        assert!(!version_covered("2.0.0", "1.99.99"));
        assert!(version_covered("1.2", "1.2.0"));
        assert!(!version_covered("1.x", "1.99.99"));
    }

    #[test]
    fn only_active_and_grace_may_write() {
        assert_eq!(Status::Active.mode(), Mode::Full);
        assert_eq!(Status::Grace.mode(), Mode::Full);
        for status in [
            Status::Unlicensed,
            Status::Invalid,
            Status::Expired,
            Status::StateMissing,
            Status::ClockRollback,
            Status::Revoked,
            Status::LeaseExpired,
        ] {
            assert_eq!(status.mode(), Mode::ReadOnly);
        }
    }
}
