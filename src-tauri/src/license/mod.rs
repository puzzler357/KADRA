//! Licence verification (LICENSING.md). Everything that decides whether
//! the app may write lives here, in Rust; the webview only displays the result.
//!
//! The manager recomputes the status at startup, every 30 minutes and after
//! every licence operation, and hands each result to a callback that sets the
//! database guard and tells the webview (`license://changed`).

pub mod client;
pub mod clock;
pub mod commands;
pub mod device_key;
pub mod files;
pub mod fingerprint;
pub mod keys;
pub mod model;
pub mod platform;
pub mod state;
pub mod store;
pub mod verify;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db::guard::Mode;
use client::Transport;
use keys::KeyRing;
use model::{ActivationMode, LicensePayload, Plan};
use platform::Platform;
use state::{Evaluation, Inputs, Status};
use store::Store;

/// 2.2 `warn_lease_days` and `warn_paid_days`.
const WARN_LEASE_DAYS: i64 = 7;
const WARN_PAID_DAYS: i64 = 14;

/// What the licence says, for display.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LicenseSummary {
    pub license_id: String,
    pub customer_name: String,
    pub edition: String,
    pub features: Vec<String>,
    pub plan: Plan,
    pub activation_mode: ActivationMode,
    pub seats: u32,
    pub activation_id: String,
    pub device_name: String,
    pub revision: u64,
    pub issued_at: DateTime<Utc>,
    pub paid_until: Option<DateTime<Utc>>,
    pub grace_days: u32,
    pub lease_until: Option<DateTime<Utc>>,
    pub max_version: Option<String>,
}

impl From<&LicensePayload> for LicenseSummary {
    fn from(license: &LicensePayload) -> Self {
        Self {
            license_id: license.license_id.clone(),
            customer_name: license.customer_name.clone(),
            edition: license.edition.clone(),
            features: license.features.clone(),
            plan: license.plan,
            activation_mode: license.activation_mode,
            seats: license.seats,
            activation_id: license.activation.activation_id.clone(),
            device_name: license.activation.device_name.clone(),
            revision: license.revision,
            issued_at: license.issued_at,
            paid_until: license.paid_until,
            grace_days: license.grace_days,
            lease_until: license.lease_until,
            max_version: license.max_version.clone(),
        }
    }
}

/// The only thing the webview learns about the licence. It is display data:
/// no command accepts any of it back.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusView {
    pub state: Status,
    pub mode: &'static str,
    pub reason: Option<String>,
    pub license: Option<LicenseSummary>,
    pub device_name: String,
    pub has_device_key: bool,
    pub last_check: Option<DateTime<Utc>>,
    /// Days since `paid_until`, while in GRACE.
    pub days_past_paid: Option<i64>,
    /// Grace days left, while in GRACE.
    pub grace_days_left: Option<i64>,
    /// Days until `paid_until`, once within the reminder window.
    pub paid_warning_days: Option<i64>,
    /// Days until `lease_until`, once within the warning window.
    pub lease_warning_days: Option<i64>,
    pub anomalies: usize,
}

type ChangeHandler = Box<dyn Fn(&StatusView) + Send + Sync>;

pub struct LicenseManager {
    platform: Arc<dyn Platform>,
    store: Store,
    ring: KeyRing,
    app_version: String,
    transport: Arc<dyn Transport>,
    /// Serialises operations: two imports racing would each read the state
    /// before the other wrote it.
    op: Mutex<()>,
    current: Mutex<Option<StatusView>>,
    on_change: Mutex<Option<ChangeHandler>>,
}

pub fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Full => "FULL",
        Mode::ReadOnly => "READ_ONLY",
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl LicenseManager {
    pub fn new(
        dir: PathBuf,
        platform: Arc<dyn Platform>,
        ring: KeyRing,
        app_version: &str,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            store: Store::new(dir, platform.clone()),
            platform,
            ring,
            app_version: app_version.to_string(),
            transport,
            op: Mutex::new(()),
            current: Mutex::new(None),
            on_change: Mutex::new(None),
        }
    }

    /// Called with every status that differs from the previous one, and
    /// once with the first.
    pub fn on_change(&self, handler: impl Fn(&StatusView) + Send + Sync + 'static) {
        *lock(&self.on_change) = Some(Box::new(handler));
    }

    /// The last computed status.
    pub fn status(&self) -> StatusView {
        if let Some(view) = lock(&self.current).clone() {
            return view;
        }
        self.refresh()
    }

    /// Writes the current time down (6) and recomputes the status.
    pub fn refresh(&self) -> StatusView {
        let _op = lock(&self.op);
        self.refresh_locked()
    }

    fn refresh_locked(&self) -> StatusView {
        let now = self.platform.now();
        let mut stored = self.store.load();
        if let Some(stored) = stored.as_mut() {
            if clock::tick(&mut stored.state, now) {
                if let Err(error) = self.store.save(stored) {
                    eprintln!("[License] could not save state: {error}");
                }
            }
        }

        let license = self
            .store
            .license_bytes()
            .map(|bytes| verify::verify_license(&bytes, &self.ring));
        let fingerprint = self.platform.fingerprint();
        let evaluation = state::evaluate(&Inputs {
            license: license.as_ref(),
            fingerprint: &fingerprint,
            device_pubkey: stored
                .as_ref()
                .and_then(|s| s.device.as_ref())
                .map(|d| d.public_b64()),
            state: stored.as_ref().map(|s| &s.state),
            now,
            app_version: &self.app_version,
        });

        let view = self.view(
            evaluation,
            license.as_ref().and_then(|l| l.as_ref().ok()),
            stored.as_ref(),
            now,
        );
        self.publish(view.clone());
        view
    }

    fn view(
        &self,
        evaluation: Evaluation,
        license: Option<&LicensePayload>,
        stored: Option<&store::Stored>,
        now: DateTime<Utc>,
    ) -> StatusView {
        let days = |from: DateTime<Utc>, to: DateTime<Utc>| (to - from).num_days();
        let status = evaluation.status;

        let (days_past_paid, grace_days_left) = match (status, license.and_then(|l| l.paid_until)) {
            (Status::Grace, Some(paid)) => {
                let grace = i64::from(license.map_or(0, |l| l.grace_days));
                let past = days(paid, now);
                (Some(past), Some((grace - past).max(0)))
            }
            _ => (None, None),
        };
        let within = |until: Option<DateTime<Utc>>, window: i64| {
            until
                .map(|until| days(now, until))
                .filter(|left| status == Status::Active && (0..=window).contains(left))
        };

        StatusView {
            state: status,
            mode: mode_name(status.mode()),
            reason: evaluation.reason,
            license: license.map(LicenseSummary::from),
            device_name: self.platform.device_name(),
            has_device_key: stored.is_some_and(|s| s.device.is_some()),
            last_check: stored.and_then(|s| s.state.last_check),
            days_past_paid,
            grace_days_left,
            paid_warning_days: within(license.and_then(|l| l.paid_until), WARN_PAID_DAYS),
            lease_warning_days: within(license.and_then(|l| l.lease_until), WARN_LEASE_DAYS),
            anomalies: stored.map_or(0, |s| s.state.anomalies.len()),
        }
    }

    fn publish(&self, view: StatusView) {
        let changed = {
            let mut current = lock(&self.current);
            let changed = current.as_ref() != Some(&view);
            *current = Some(view.clone());
            changed
        };
        if changed {
            if let Some(handler) = lock(&self.on_change).as_ref() {
                handler(&view);
            }
        }
    }

    #[cfg(test)]
    pub fn store(&self) -> &Store {
        &self.store
    }
}

#[cfg(test)]
mod tests;
