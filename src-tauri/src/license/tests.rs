//! Acceptance tests of stage 2 (LICENSING.md 13), run through the manager
//! with a substituted clock, fingerprint and storage. Test numbers match the
//! spec. Tests 1 and 2 live in verify.rs, 29 in clock.rs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::SigningKey;
use serde_json::json;

use super::device_key::verify_request;
use super::model::{RequestPayload, RequestType, SignedRequest, SignedStatus, StatusKind};
use super::platform::fake::FakeMachine;
use super::state::Status;
use super::verify::testing::{seal, signing_key};
use super::*;
use crate::db::{Database, DbError};

const KID: &str = "test-kid";

fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

/// The seller's side: what the utility does, reduced to what tests need.
struct Vendor {
    key: SigningKey,
}

#[derive(Clone)]
struct Terms {
    license_id: &'static str,
    activation_id: &'static str,
    revision: u64,
    plan: &'static str,
    mode: &'static str,
    issued_at: DateTime<Utc>,
    paid_until: Option<DateTime<Utc>>,
    lease_until: Option<DateTime<Utc>>,
    refresh_after: Option<DateTime<Utc>>,
    max_version: &'static str,
}

impl Terms {
    /// A year of ANNUAL/OFFLINE from `issued_at` (2.1: lease = paid + 7).
    fn annual(issued_at: DateTime<Utc>) -> Self {
        let paid = issued_at + Duration::days(365);
        Self {
            license_id: "HRD-2026-000001",
            activation_id: "ACT-00000001",
            revision: 1,
            plan: "ANNUAL",
            mode: "OFFLINE",
            issued_at,
            paid_until: Some(paid),
            lease_until: Some(paid + Duration::days(7)),
            refresh_after: None,
            max_version: "1.99.99",
        }
    }

    fn perpetual(issued_at: DateTime<Utc>) -> Self {
        Self {
            plan: "PERPETUAL",
            paid_until: None,
            lease_until: None,
            ..Self::annual(issued_at)
        }
    }
}

impl Vendor {
    fn new() -> Self {
        Self {
            key: signing_key(7),
        }
    }

    fn ring(&self) -> KeyRing {
        KeyRing::with(KID, self.key.verifying_key())
    }

    fn license(&self, request: &RequestPayload, terms: &Terms) -> Vec<u8> {
        let payload = json!({
            "v": 1,
            "license_id": terms.license_id,
            "revision": terms.revision,
            "customer_id": "CUST-1",
            "customer_name": "ABC Ltd.",
            "product": "HRDESK",
            "edition": "PRO",
            "features": [],
            "plan": terms.plan,
            "activation_mode": terms.mode,
            "seats": 1,
            "activation": {
                "activation_id": terms.activation_id,
                "device_name": request.device_name,
                "device_pubkey": request.device_pubkey,
                "fp": request.fp,
                "fp_threshold": 2
            },
            "issued_at": terms.issued_at,
            "paid_until": terms.paid_until,
            "grace_days": 7,
            "lease_until": terms.lease_until,
            "refresh_after": terms.refresh_after,
            "max_version": terms.max_version
        });
        seal(KID, &self.key, &serde_json::to_vec(&payload).unwrap())
    }

    fn status(&self, status: &SignedStatus) -> Vec<u8> {
        seal(KID, &self.key, &serde_json::to_vec(status).unwrap())
    }
}

/// One computer with HRDesk: its machine, licence manager and database.
struct Client {
    machine: Arc<FakeMachine>,
    manager: LicenseManager,
    db: Arc<Database>,
    dir: PathBuf,
}

impl Client {
    fn new(vendor: &Vendor, machine: Arc<FakeMachine>, dir: &Path) -> Self {
        Self::with_transport(vendor, machine, dir, Arc::new(super::client::Offline))
    }

    fn with_transport(
        vendor: &Vendor,
        machine: Arc<FakeMachine>,
        dir: &Path,
        transport: Arc<dyn super::client::Transport>,
    ) -> Self {
        let manager = LicenseManager::new(
            dir.join("license"),
            machine.clone(),
            vendor.ring(),
            "1.0.0",
            transport,
        );
        let db = Arc::new(Database::open(&dir.join(crate::db::DATABASE_FILE)).unwrap());
        let guarded = Arc::clone(&db);
        manager.on_change(move |view| guarded.guard().set_mode(view.state.mode()));
        manager.refresh();
        Self {
            machine,
            manager,
            db,
            dir: dir.to_path_buf(),
        }
    }

    fn request(&self, kind: RequestType) -> RequestPayload {
        let path = self.dir.join("request.hrdreq");
        let key =
            (kind == RequestType::Activate).then(|| "HRD-AAAAA-BBBBB-CCCCC-DDDDD".to_string());
        self.manager.export_request(kind, key, &path).unwrap();
        let signed: SignedRequest = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        verify_request(&signed).expect("the request carries a valid device signature")
    }

    /// First activation by file exchange: request out, licence in.
    fn activate(&self, vendor: &Vendor, terms: &Terms) -> RequestPayload {
        let request = self.request(RequestType::Activate);
        self.manager
            .import_bytes(&vendor.license(&request, terms))
            .unwrap();
        request
    }

    fn status(&self) -> Status {
        self.manager.refresh().state
    }

    fn can_write(&self) -> bool {
        match self.db.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('probe', 'x')",
            &[],
        ) {
            Ok(()) => true,
            Err(DbError::Denied(_)) => false,
            Err(other) => panic!("unexpected error {other}"),
        }
    }

    fn can_read_and_export(&self) -> bool {
        self.db
            .select("SELECT count(*) AS n FROM employees", &[])
            .is_ok()
            && self.db.serialize().is_ok()
    }
}

struct World {
    vendor: Vendor,
    _temp: tempfile::TempDir,
    client: Client,
}

fn world(now: DateTime<Utc>) -> World {
    let temp = tempfile::tempdir().unwrap();
    let vendor = Vendor::new();
    let client = Client::new(&vendor, Arc::new(FakeMachine::new(now, 1)), temp.path());
    World {
        vendor,
        _temp: temp,
        client,
    }
}

const START: &str = "2026-09-27T16:00:00Z";

#[test]
fn a_fresh_install_is_unlicensed_and_read_only() {
    let w = world(at(START));
    assert_eq!(w.client.status(), Status::Unlicensed);
    assert!(!w.client.can_write());
}

#[test]
fn offline_activation_by_file_exchange() {
    let w = world(at(START));
    let request = w.client.activate(&w.vendor, &Terms::annual(at(START)));
    assert_eq!(request.kind, RequestType::Activate);
    assert_eq!(
        request.license_key.as_deref(),
        Some("HRD-AAAAA-BBBBB-CCCCC-DDDDD")
    );
    assert_eq!(w.client.status(), Status::Active);
    assert!(w.client.can_write());
}

#[test]
fn request_counter_grows() {
    let w = world(at(START));
    let first = w.client.request(RequestType::Activate);
    let second = w.client.request(RequestType::Activate);
    assert!(second.counter > first.counter);
    assert_ne!(first.nonce, second.nonce);
    assert_eq!(
        first.device_pubkey, second.device_pubkey,
        "one device key per device"
    );
}

// Test 3: the licence and the vault copied to another computer.
#[test]
fn t03_copied_to_another_computer_is_machine_mismatch() {
    let w = world(at(START));
    w.client.activate(&w.vendor, &Terms::annual(at(START)));

    let other = Arc::new(FakeMachine::new(at(START), 2));
    *other.vault.lock().unwrap() = w.client.machine.vault.lock().unwrap().clone();
    let copy = Client::new(&w.vendor, other, &w.client.dir);

    assert_eq!(copy.status(), Status::MachineMismatch);
    assert!(!copy.can_write());
}

// Test 4: one component replaced, two of three still match.
#[test]
fn t04_disk_replaced_is_still_active() {
    let w = world(at(START));
    w.client.activate(&w.vendor, &Terms::annual(at(START)));
    w.client.machine.fp.lock().unwrap().disk = "new-disk".into();
    assert_eq!(w.client.status(), Status::Active);
}

// Test 5 (offline part): Windows reinstalled - MachineGuid new, vault gone.
#[test]
fn t05_reinstall_needs_rebind_and_a_new_file_restores_it() {
    let w = world(at(START));
    let terms = Terms::annual(at(START));
    w.client.activate(&w.vendor, &terms);

    w.client.machine.fp.lock().unwrap().mg = "reinstalled".into();
    *w.client.machine.vault.lock().unwrap() = None;
    assert_eq!(w.client.status(), Status::RebindRequired);
    assert!(!w.client.can_write());

    let rebind = w.client.request(RequestType::Rebind);
    assert_eq!(rebind.license_id.as_deref(), Some(terms.license_id));
    assert_eq!(rebind.activation_id.as_deref(), Some(terms.activation_id));
    w.client
        .manager
        .import_bytes(&w.vendor.license(
            &rebind,
            &Terms {
                revision: 2,
                ..terms
            },
        ))
        .unwrap();
    assert_eq!(w.client.status(), Status::Active);
}

// Test 6: three days back is a rollback, one day is within tolerance.
#[test]
fn t06_clock_set_back() {
    let now = at(START);
    let w = world(now);
    w.client
        .activate(&w.vendor, &Terms::annual(now - Duration::days(30)));
    assert_eq!(w.client.status(), Status::Active);

    w.client.machine.set_now(now - Duration::days(3));
    assert_eq!(w.client.status(), Status::ClockRollback);
    assert!(!w.client.can_write());

    w.client.machine.set_now(now - Duration::days(1));
    assert_eq!(w.client.status(), Status::Active);
}

// Test 7: the audit log shows this device already worked five days ahead.
#[test]
fn t07_audit_anchor_ahead_of_the_clock() {
    let now = at(START);
    let w = world(now);
    w.client
        .activate(&w.vendor, &Terms::annual(now - Duration::days(30)));
    let view = w
        .client
        .manager
        .report_time_anchor(&(now + Duration::days(5)).to_rfc3339())
        .unwrap();
    assert_eq!(view.state, Status::ClockRollback);
}

// Test 9: paid_until three days ago - grace, writes allowed.
#[test]
fn t09_grace_keeps_writing() {
    let issued = at(START);
    let w = world(issued);
    let terms = Terms::annual(issued);
    w.client.activate(&w.vendor, &terms);

    w.client
        .machine
        .set_now(terms.paid_until.unwrap() + Duration::days(3));
    let view = w.client.manager.refresh();
    assert_eq!(view.state, Status::Grace);
    assert_eq!(view.days_past_paid, Some(3));
    assert_eq!(view.grace_days_left, Some(4));
    assert!(w.client.can_write());
}

// Test 10: eight days past - expired, writes refused, reading and export work.
#[test]
fn t10_expired_reads_but_does_not_write() {
    let issued = at(START);
    let w = world(issued);
    let terms = Terms::annual(issued);
    w.client.activate(&w.vendor, &terms);

    w.client
        .machine
        .set_now(terms.paid_until.unwrap() + Duration::days(8));
    assert_eq!(w.client.status(), Status::Expired);
    assert!(!w.client.can_write());
    assert!(w.client.can_read_and_export());
}

// Test 11: a renewal file brings the licence back and the dates move.
#[test]
fn t11_renewal_file_restores_and_updates_dates() {
    let issued = at(START);
    let w = world(issued);
    let terms = Terms::annual(issued);
    let request = w.client.activate(&w.vendor, &terms);

    w.client
        .machine
        .set_now(terms.paid_until.unwrap() + Duration::days(8));
    assert_eq!(w.client.status(), Status::Expired);

    let renewed_paid = terms.paid_until.unwrap() + Duration::days(365);
    let renewal = Terms {
        revision: 2,
        issued_at: w.client.machine.now(),
        paid_until: Some(renewed_paid),
        lease_until: Some(renewed_paid + Duration::days(7)),
        ..terms
    };
    // 5.3: no new request - the vendor reuses what the device sent before.
    let view = w
        .client
        .manager
        .import_bytes(&w.vendor.license(&request, &renewal))
        .unwrap();
    assert_eq!(view.state, Status::Active);
    assert_eq!(view.license.unwrap().paid_until, Some(renewed_paid));
    assert!(w.client.can_write());
}

// Test 12: an older revision is refused.
#[test]
fn t12_older_revision_is_refused() {
    let w = world(at(START));
    let terms = Terms {
        revision: 3,
        ..Terms::annual(at(START))
    };
    let request = w.client.activate(&w.vendor, &terms);

    let older = w.vendor.license(
        &request,
        &Terms {
            revision: 2,
            ..terms
        },
    );
    let error = w.client.manager.import_bytes(&older).unwrap_err();
    assert!(error.contains("устарел"), "{error}");
}

#[test]
fn a_licence_for_another_device_key_is_refused() {
    let w = world(at(START));
    let mut request = w.client.request(RequestType::Activate);
    request.device_pubkey = super::device_key::DeviceKey::generate().public_b64();
    let error = w
        .client
        .manager
        .import_bytes(&w.vendor.license(&request, &Terms::annual(at(START))));
    assert!(error.unwrap_err().contains("другого устройства"));
}

// Test 14 at the manager level (the network half is stage 4): a signed
// REVOKED is read-only, survives a restart, and the old file cannot undo it.
#[test]
fn t14_revoked_sticks_and_the_old_file_does_not_undo_it() {
    let w = world(at(START));
    let terms = Terms::annual(at(START));
    let request = w.client.activate(&w.vendor, &terms);

    let revoked = SignedStatus {
        v: 1,
        kind: StatusKind::Revoked,
        license_id: terms.license_id.into(),
        activation_id: terms.activation_id.into(),
        revision: 2,
        nonce: Some("n-1".into()),
        issued_at: at(START),
        high_water_to: None,
    };
    w.client
        .manager
        .accept_server_status(&revoked, "n-1")
        .unwrap();
    assert_eq!(w.client.status(), Status::Revoked);

    let restarted = Client::new(&w.vendor, w.client.machine.clone(), &w.client.dir);
    assert_eq!(restarted.status(), Status::Revoked);
    assert!(!restarted.can_write());

    assert!(restarted
        .manager
        .import_bytes(&w.vendor.license(&request, &terms))
        .is_err());
}

// Test 28 at the manager level: a status answering someone else's request.
#[test]
fn t28_status_with_a_foreign_nonce_is_rejected() {
    let w = world(at(START));
    let terms = Terms::annual(at(START));
    w.client.activate(&w.vendor, &terms);
    let revoked = SignedStatus {
        v: 1,
        kind: StatusKind::Revoked,
        license_id: terms.license_id.into(),
        activation_id: terms.activation_id.into(),
        revision: 2,
        nonce: Some("old".into()),
        issued_at: at(START),
        high_water_to: None,
    };
    assert!(w
        .client
        .manager
        .accept_server_status(&revoked, "sent")
        .is_err());
    assert_eq!(w.client.status(), Status::Active);
}

// Test 19: a perpetual offline licence, five years without contact.
#[test]
fn t19_perpetual_offline_after_five_years() {
    let w = world(at(START));
    w.client.activate(&w.vendor, &Terms::perpetual(at(START)));
    w.client.machine.advance(Duration::days(5 * 365));
    assert_eq!(w.client.status(), Status::Active);
    assert!(w.client.can_write());
}

// Test 21: a row three years ahead is ignored and journalled.
#[test]
fn t21_anchor_three_years_ahead_is_an_anomaly() {
    let now = at(START);
    let w = world(now);
    w.client.activate(&w.vendor, &Terms::annual(now));
    let view = w
        .client
        .manager
        .report_time_anchor(&(now + Duration::days(3 * 365)).to_rfc3339())
        .unwrap();
    assert_eq!(view.state, Status::Active);
    assert_eq!(view.anomalies, 1);
}

// Test 22: an anchor in the past leaves the mark alone.
#[test]
fn t22_an_older_anchor_changes_nothing() {
    let now = at(START);
    let w = world(now);
    w.client.activate(&w.vendor, &Terms::annual(now));
    let before = w.client.manager.store().load().unwrap().state.high_water;
    w.client
        .manager
        .report_time_anchor(&(now - Duration::days(10)).to_rfc3339())
        .unwrap();
    assert_eq!(
        w.client.manager.store().load().unwrap().state.high_water,
        before
    );
}

// Test 24, OFFLINE: state.bin and the registry vault deleted.
#[test]
fn t24_offline_state_wiped_needs_a_new_file() {
    let w = world(at(START));
    w.client.activate(&w.vendor, &Terms::annual(at(START)));

    std::fs::remove_file(w.client.manager.store().state_file()).unwrap();
    assert_eq!(w.client.status(), Status::Active, "one copy is enough");

    // The refresh above may have written the file back; now both copies go.
    let _ = std::fs::remove_file(w.client.manager.store().state_file());
    *w.client.machine.vault.lock().unwrap() = None;
    assert_eq!(w.client.status(), Status::RebindRequired);
    assert!(!w.client.can_write());
}

// Test 24, STATE_MISSING: the state does not describe the installed licence
// (a licence file put in place by hand). ONLINE without network: read-only.
#[test]
fn t24_online_licence_without_its_state_is_read_only() {
    let w = world(at(START));
    let terms = Terms::annual(at(START));
    let request = w.client.activate(&w.vendor, &terms);

    let other = Terms {
        license_id: "HRD-2026-000777",
        mode: "ONLINE",
        ..terms.clone()
    };
    std::fs::write(
        w.client.dir.join("license").join(store::LICENSE_FILE),
        w.vendor.license(&request, &other),
    )
    .unwrap();
    assert_eq!(w.client.status(), Status::StateMissing);
    assert!(!w.client.can_write());

    let offline = Terms {
        license_id: "HRD-2026-000778",
        ..terms
    };
    std::fs::write(
        w.client.dir.join("license").join(store::LICENSE_FILE),
        w.vendor.license(&request, &offline),
    )
    .unwrap();
    assert_eq!(w.client.status(), Status::RebindRequired);
}

// Test 25: rollback lifted by the vendor's signed .hrdclock, once.
#[test]
fn t25_clock_reset_file_lifts_the_rollback() {
    let now = at(START);
    let w = world(now);
    let terms = Terms::annual(now - Duration::days(30));
    w.client.activate(&w.vendor, &terms);

    // The clock once ran a month ahead, then was corrected.
    w.client.machine.set_now(now + Duration::days(30));
    w.client.status();
    w.client.machine.set_now(now);
    assert_eq!(w.client.status(), Status::ClockRollback);

    let reset = w.vendor.status(&SignedStatus {
        v: 1,
        kind: StatusKind::ClockReset,
        license_id: terms.license_id.into(),
        activation_id: terms.activation_id.into(),
        revision: 2,
        nonce: None,
        issued_at: now,
        high_water_to: Some(now),
    });
    let view = w.client.manager.import_bytes(&reset).unwrap();
    assert_eq!(view.state, Status::Active);
    assert!(w.client.can_write());

    assert!(
        w.client.manager.import_bytes(&reset).is_err(),
        "a reset works once"
    );
}

// Test 26: an empty data directory in READ_ONLY - the database is created
// and the schema applied, SELECT works, INSERT is refused.
#[test]
fn t26_read_only_on_an_empty_data_directory() {
    let w = world(at(START));
    assert_eq!(w.client.status().mode(), crate::db::guard::Mode::ReadOnly);
    assert!(w.client.db.is_empty());
    assert!(w.client.can_read_and_export());
    assert!(!w.client.can_write());
}

// Test 27: db_execute and db_transaction called directly in READ_ONLY.
#[test]
fn t27_direct_writes_are_refused_in_read_only() {
    let w = world(at(START));
    assert!(matches!(
        w.client.db.execute("DELETE FROM employees", &[]),
        Err(DbError::Denied(_))
    ));
    assert!(matches!(
        w.client.db.transaction(&[crate::db::SqlStatement {
            sql: "INSERT INTO departments (id, name) VALUES ('x', 'x')".into(),
            params: vec![],
        }]),
        Err(DbError::Denied(_))
    ));
}

// Test 29 through the manager: two years of a perpetual licence with the
// journal's ordinary rows reported every day.
#[test]
fn t29_perpetual_two_years_of_ordinary_anchors() {
    let issued = at(START);
    let w = world(issued);
    w.client.activate(&w.vendor, &Terms::perpetual(issued));
    for _ in 0..(2 * 365) {
        w.client.machine.advance(Duration::days(1));
        w.client.manager.refresh();
        let row = w.client.machine.now() - Duration::minutes(3);
        let view = w
            .client
            .manager
            .report_time_anchor(&row.to_rfc3339())
            .unwrap();
        assert_eq!(view.state, Status::Active);
    }
    assert_eq!(w.client.manager.refresh().anomalies, 0);
}

// 7.2, offline: the proof is signed by the device, then licence and key go.
#[test]
fn offline_deactivation_writes_a_proof_and_removes_the_licence() {
    let w = world(at(START));
    let terms = Terms::annual(at(START));
    let request = w.client.activate(&w.vendor, &terms);

    let path = w.client.dir.join("proof.hrddeact");
    let view = w.client.manager.deactivate(&path).unwrap();
    assert_eq!(view.state, Status::Unlicensed);
    assert!(!view.has_device_key);

    let proof: SignedRequest = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let proof = verify_request(&proof).unwrap();
    assert_eq!(proof.kind, RequestType::Deactivate);
    assert_eq!(proof.activation_id.as_deref(), Some(terms.activation_id));
    assert_eq!(proof.device_pubkey, request.device_pubkey);

    assert!(w
        .client
        .manager
        .import_bytes(&w.vendor.license(&request, &terms))
        .is_err());
}

#[test]
fn version_beyond_the_licence_is_not_covered() {
    let w = world(at(START));
    w.client.activate(
        &w.vendor,
        &Terms {
            max_version: "0.9.0",
            ..Terms::annual(at(START))
        },
    );
    assert_eq!(w.client.status(), Status::VersionNotCovered);
}

#[test]
fn warnings_appear_inside_their_windows() {
    let issued = at(START);
    let w = world(issued);
    let terms = Terms::annual(issued);
    w.client.activate(&w.vendor, &terms);

    assert_eq!(w.client.manager.refresh().paid_warning_days, None);
    w.client
        .machine
        .set_now(terms.paid_until.unwrap() - Duration::days(10));
    assert_eq!(w.client.manager.refresh().paid_warning_days, Some(10));
}

#[test]
fn the_status_change_callback_fires_on_changes_only() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let w = world(at(START));
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    w.client.manager.on_change(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    w.client.manager.refresh();
    w.client.manager.refresh();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    w.client.activate(&w.vendor, &Terms::annual(at(START)));
    assert!(calls.load(Ordering::SeqCst) >= 1);
}

/// End to end with the real seller side: this client writes a request, the
/// console utility (license-server's code) issues a licence, the client
/// installs it; then a renewal and an offline deactivation go the same way.
/// Needs Node 22.18+ on PATH:
///   cargo test --lib e2e_with_the_licence_server -- --ignored
#[cfg(debug_assertions)]
#[test]
#[ignore]
fn e2e_with_the_licence_server() {
    use std::process::Command;

    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let db = dir.join("license.db");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let cli = |args: &[&str]| -> String {
        let output = Command::new("node")
            .current_dir(&repo)
            .arg("tools/hrd-license/cli.js")
            .args(args)
            .args(["--dev", "--db", db.to_str().unwrap()])
            .output()
            .expect("node on PATH");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        assert!(
            output.status.success(),
            "{args:?}: {stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        stdout
    };
    let after = |text: &str, marker: &str| -> String {
        let start = text
            .find(marker)
            .unwrap_or_else(|| panic!("no {marker} in {text}"))
            + marker.len();
        text[start..]
            .split_whitespace()
            .next()
            .unwrap()
            .trim_end_matches([':', ','])
            .to_string()
    };
    let only_file = |dir: &Path, extension: &str| -> PathBuf {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == extension))
            .unwrap_or_else(|| panic!("no .{extension} in {}", dir.display()))
    };

    let machine = Arc::new(FakeMachine::new(Utc::now(), 1));
    let manager = LicenseManager::new(
        dir.join("client"),
        machine.clone(),
        KeyRing::embedded(),
        "1.0.0",
        Arc::new(super::client::Offline),
    );
    assert_eq!(manager.refresh().state, Status::Unlicensed);

    let customer = after(&cli(&["customer", "--name", "E2E Ltd."]), "Клиент ");
    let created = cli(&[
        "license",
        "--customer",
        &customer,
        "--plan",
        "ANNUAL",
        "--mode",
        "OFFLINE",
    ]);
    let key = after(&created, "показывается один раз): ");
    let license_id = after(&created, "Лицензия ");

    let request = dir.join("request.hrdreq");
    manager
        .export_request(RequestType::Activate, Some(key), &request)
        .unwrap();
    let issued = dir.join("issued");
    cli(&[
        "issue",
        "--request",
        request.to_str().unwrap(),
        "--out",
        issued.to_str().unwrap(),
    ]);
    let view = manager.import(&only_file(&issued, "hrdlic")).unwrap();
    assert_eq!(view.state, Status::Active);
    assert_eq!(view.license.as_ref().unwrap().license_id, license_id);
    let paid = view.license.unwrap().paid_until.unwrap();

    // 5.3: a renewal needs no new request.
    let renewed = dir.join("renewed");
    cli(&[
        "renew",
        "--license-id",
        &license_id,
        "--out",
        renewed.to_str().unwrap(),
    ]);
    let view = manager.import(&only_file(&renewed, "hrdlic")).unwrap();
    assert_eq!(view.state, Status::Active);
    assert!(view.license.unwrap().paid_until.unwrap() > paid);

    // 7.2 offline: the proof frees the seat on the seller's side.
    let proof = dir.join("proof.hrddeact");
    assert_eq!(
        manager.deactivate(&proof).unwrap().state,
        Status::Unlicensed
    );
    assert!(cli(&["release", "--proof", proof.to_str().unwrap()]).contains("Место освобождено"));
}

mod online;
