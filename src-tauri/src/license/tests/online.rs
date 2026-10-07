//! Stage 4 acceptance tests (LICENSING.md 13): 8, 13, 14, 24 (ONLINE)
//! and 28, with a fake server behind the transport. The fake checks the
//! device signature exactly as the real one does.

use std::sync::Mutex;

use super::super::client::{FakeTransport, HttpReply, Outcome};
use super::super::device_key::verify_request;
use super::super::model::Fingerprint;
use super::*;

#[derive(Clone)]
enum Behaviour {
    Up,
    Down,
    Status500,
    Unsigned403,
    ForgedAnswer,
    Revoke {
        nonce: Option<String>,
    },
    Transfer,
    /// A TRANSFERRED that answers some other request.
    TransferForeign,
}

/// The licence server: issues ONLINE files by the rules of 2.1 with its own
/// clock, or misbehaves on demand.
struct Server {
    behaviour: Arc<Mutex<Behaviour>>,
    now: Arc<Mutex<DateTime<Utc>>>,
    transport: Arc<FakeTransport>,
}

impl Server {
    fn start(
        vendor: &Vendor,
        now: DateTime<Utc>,
        paid_until: DateTime<Utc>,
        plan: &'static str,
    ) -> Self {
        let behaviour = Arc::new(Mutex::new(Behaviour::Up));
        let clock = Arc::new(Mutex::new(now));
        let revision = Arc::new(Mutex::new(0u64));
        let key = vendor.key.clone();

        let (b, c) = (Arc::clone(&behaviour), Arc::clone(&clock));
        let transport = FakeTransport::new(move |url, body| {
            let vendor = Vendor { key: key.clone() };
            let now = *c.lock().unwrap();
            let signed: SignedRequest = serde_json::from_slice(body).map_err(|e| e.to_string())?;
            let request = verify_request(&signed).ok_or("server: bad device signature")?;
            let reply = |status: u16, body: String| {
                Ok(HttpReply {
                    status,
                    body: body.into_bytes(),
                })
            };
            let envelope = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();

            let behaviour = b.lock().unwrap().clone();
            let status_of = |kind: StatusKind, nonce: Option<String>, revision: u64| SignedStatus {
                v: 1,
                kind,
                license_id: request.license_id.clone().unwrap_or_default(),
                activation_id: request.activation_id.clone().unwrap_or_default(),
                revision,
                nonce,
                issued_at: now,
                high_water_to: None,
            };
            let mut revision = revision.lock().unwrap();
            match behaviour {
                Behaviour::Down => Err("connection refused".into()),
                Behaviour::Status500 => reply(500, r#"{"error":"INTERNAL"}"#.into()),
                Behaviour::Unsigned403 => reply(
                    403,
                    r#"{"error":"LICENSE_REVOKED","message":"Лицензия отозвана"}"#.into(),
                ),
                Behaviour::ForgedAnswer => {
                    *revision += 1;
                    let forger = Vendor {
                        key: signing_key(99),
                    };
                    let terms = online_terms(now, paid_until, plan, *revision);
                    reply(
                        200,
                        format!(
                            r#"{{"license":{}}}"#,
                            envelope(forger.license(&request, &terms))
                        ),
                    )
                }
                Behaviour::Revoke { nonce } => {
                    *revision += 1;
                    let status = status_of(
                        StatusKind::Revoked,
                        Some(nonce.unwrap_or(request.nonce.clone())),
                        *revision,
                    );
                    reply(
                        200,
                        format!(r#"{{"status":{}}}"#, envelope(vendor.status(&status))),
                    )
                }
                Behaviour::Transfer => {
                    *revision += 1;
                    let status = status_of(
                        StatusKind::Transferred,
                        Some(request.nonce.clone()),
                        *revision,
                    );
                    reply(
                        200,
                        format!(r#"{{"status":{}}}"#, envelope(vendor.status(&status))),
                    )
                }
                Behaviour::TransferForeign => {
                    *revision += 1;
                    let status = status_of(
                        StatusKind::Transferred,
                        Some("someone-else".into()),
                        *revision,
                    );
                    reply(
                        200,
                        format!(r#"{{"status":{}}}"#, envelope(vendor.status(&status))),
                    )
                }
                // 7.2 online: the seat is freed, a signed TRANSFERRED confirms it.
                Behaviour::Up if url.ends_with("/deactivate") => {
                    assert_eq!(request.kind, RequestType::Deactivate);
                    *revision += 1;
                    let status = status_of(
                        StatusKind::Transferred,
                        Some(request.nonce.clone()),
                        *revision,
                    );
                    reply(
                        200,
                        format!(r#"{{"status":{}}}"#, envelope(vendor.status(&status))),
                    )
                }
                Behaviour::Up => {
                    assert!(
                        url.ends_with("/activate")
                            || url.ends_with("/refresh")
                            || url.ends_with("/rebind"),
                        "{url}"
                    );
                    if url.ends_with("/rebind") {
                        assert_eq!(request.kind, RequestType::Rebind);
                    }
                    *revision += 1;
                    let terms = online_terms(now, paid_until, plan, *revision);
                    reply(
                        200,
                        format!(
                            r#"{{"license":{}}}"#,
                            envelope(vendor.license(&request, &terms))
                        ),
                    )
                }
            }
        });
        Self {
            behaviour,
            now: clock,
            transport,
        }
    }

    fn set(&self, behaviour: Behaviour) {
        *self.behaviour.lock().unwrap() = behaviour;
    }

    fn set_now(&self, now: DateTime<Utc>) {
        *self.now.lock().unwrap() = now;
    }
}

/// 2.1 ONLINE: a 30-day lease, never past paid + 7; refresh after 7 days.
fn online_terms(
    now: DateTime<Utc>,
    paid_until: DateTime<Utc>,
    plan: &'static str,
    revision: u64,
) -> Terms {
    let lease = (now + Duration::days(30)).min(paid_until + Duration::days(7));
    Terms {
        revision,
        plan,
        mode: "ONLINE",
        issued_at: now,
        paid_until: Some(paid_until),
        lease_until: Some(lease),
        refresh_after: Some(now + Duration::days(7)),
        ..Terms::annual(now)
    }
}

struct Online {
    _temp: tempfile::TempDir,
    vendor: Vendor,
    server: Server,
    client: Client,
}

const KEY: &str = "HRD-AAAAA-BBBBB-CCCCC-DDDDD";

/// A MONTHLY ONLINE licence activated over the network at START, paid for 30 days.
fn online() -> Online {
    let temp = tempfile::tempdir().unwrap();
    let vendor = Vendor::new();
    let now = at(START);
    let server = Server::start(&vendor, now, now + Duration::days(30), "MONTHLY");
    let machine = Arc::new(FakeMachine::new(now, 1));
    let client = Client::with_transport(&vendor, machine, temp.path(), server.transport.clone());
    let view = client.manager.activate_online(KEY).unwrap();
    assert_eq!(view.state, Status::Active);
    assert!(view.last_check.is_some());
    Online {
        _temp: temp,
        vendor,
        server,
        client,
    }
}

fn license_file(client: &Client) -> Vec<u8> {
    std::fs::read(client.dir.join("license").join(store::LICENSE_FILE)).unwrap()
}

#[test]
fn online_activation_installs_a_short_lease() {
    let o = online();
    let license = o.client.manager.refresh().license.unwrap();
    assert_eq!(license.activation_mode, ActivationMode::Online);
    assert_eq!(license.lease_until, Some(at(START) + Duration::days(30)));
    assert!(o.client.can_write());
}

#[test]
fn online_activation_without_network_explains_the_offline_way() {
    let temp = tempfile::tempdir().unwrap();
    let vendor = Vendor::new();
    let server = Server::start(
        &vendor,
        at(START),
        at(START) + Duration::days(30),
        "MONTHLY",
    );
    server.set(Behaviour::Down);
    let client = Client::with_transport(
        &vendor,
        Arc::new(FakeMachine::new(at(START), 1)),
        temp.path(),
        server.transport.clone(),
    );
    let error = client.manager.activate_online(KEY).unwrap_err();
    assert!(error.contains("обменом файлами"), "{error}");
    assert_eq!(client.status(), Status::Unlicensed);
}

// Test 8: MONTHLY ONLINE, network gone. 29 days: working; 31: LEASE_EXPIRED.
#[test]
fn t08_lease_runs_out_without_network() {
    let o = online();
    o.server.set(Behaviour::Down);

    o.client.machine.set_now(at(START) + Duration::days(29));
    let (view, outcome) = o.client.manager.refresh_online();
    assert!(matches!(outcome, Outcome::Unreachable(_)));
    assert_eq!(view.state, Status::Active);
    assert!(o.client.can_write());

    o.client.machine.set_now(at(START) + Duration::days(31));
    assert_eq!(o.client.status(), Status::LeaseExpired);
    assert!(!o.client.can_write());
    assert!(
        o.client.manager.refresh_due(),
        "a lapsed lease keeps asking"
    );
}

#[test]
fn a_refresh_moves_the_lease_but_never_past_paid_plus_grace() {
    let o = online();
    let day8 = at(START) + Duration::days(8);
    o.client.machine.set_now(day8);
    o.server.set_now(day8);
    assert!(o.client.manager.refresh_due());

    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    // min(day 8 + 30, paid (day 30) + 7) = day 37.
    assert_eq!(
        view.license.unwrap().lease_until,
        Some(at(START) + Duration::days(37))
    );
    assert!(
        !o.client.manager.refresh_due(),
        "not again before the new refresh_after"
    );
}

// Test 13: the server answers 500 - nothing changes.
#[test]
fn t13_server_error_changes_nothing() {
    let o = online();
    o.client.machine.set_now(at(START) + Duration::days(8));
    let before_file = license_file(&o.client);
    // After the ordinary clock tick, so only the server's answer could differ.
    let before_view = o.client.manager.refresh();
    let before_state = o.client.manager.store().load().unwrap().state;

    for behaviour in [
        Behaviour::Status500,
        Behaviour::Unsigned403,
        Behaviour::ForgedAnswer,
    ] {
        o.server.set(behaviour);
        let (view, outcome) = o.client.manager.refresh_online();
        assert!(!matches!(outcome, Outcome::Updated), "{outcome:?}");
        assert_eq!(view.state, before_view.state);
        assert_eq!(view.license, before_view.license);
    }

    assert_eq!(license_file(&o.client), before_file);
    let after = o.client.manager.store().load().unwrap().state;
    assert_eq!(after.track, before_state.track);
    assert_eq!(after.high_water, before_state.high_water);
    assert_eq!(after.last_check, before_state.last_check);
}

// Test 14: a signed REVOKED - read-only, and the old file cannot undo it.
#[test]
fn t14_signed_revocation() {
    let o = online();
    let old = license_file(&o.client);
    o.client.machine.set_now(at(START) + Duration::days(8));
    o.server.set(Behaviour::Revoke { nonce: None });

    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Revoked);
    assert_eq!(view.state, Status::Revoked);
    assert!(!o.client.can_write());

    assert!(o.client.manager.import_bytes(&old).is_err());
    assert_eq!(o.client.status(), Status::Revoked);
}

// Test 28: a REVOKED answering someone else's request is ignored.
#[test]
fn t28_revocation_with_a_foreign_nonce_is_rejected() {
    let o = online();
    o.client.machine.set_now(at(START) + Duration::days(8));
    o.server.set(Behaviour::Revoke {
        nonce: Some("replayed-from-another-request".into()),
    });

    let (view, outcome) = o.client.manager.refresh_online();
    assert!(matches!(outcome, Outcome::Refused(_)), "{outcome:?}");
    assert_eq!(view.state, Status::Active);
    assert!(o.client.can_write());
}

#[test]
fn transferred_removes_the_licence_and_the_key() {
    let o = online();
    o.client.machine.set_now(at(START) + Duration::days(8));
    o.server.set(Behaviour::Transfer);
    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Transferred);
    assert_eq!(view.state, Status::Unlicensed);
    assert!(!view.has_device_key);
}

// Test 24, ONLINE: the state does not describe the installed licence.
// Without network: read-only. With network: active, state made anew.
#[test]
fn t24_online_state_missing_is_restored_by_the_server() {
    let o = online();
    let request = RequestPayload {
        kind: RequestType::Refresh,
        license_key: None,
        license_id: None,
        activation_id: None,
        current_revision: None,
        device_name: "PC-1".into(),
        device_pubkey: o
            .client
            .manager
            .store()
            .load()
            .unwrap()
            .device
            .unwrap()
            .public_b64(),
        fp: o.client.machine.fp.lock().unwrap().clone(),
        app_version: "1.0.0".into(),
        client_time: at(START),
        counter: 1,
        nonce: "n".into(),
    };
    // A file for another licence of this device, put in place by hand.
    let foreign = Terms {
        license_id: "HRD-2026-000900",
        ..online_terms(at(START), at(START) + Duration::days(30), "MONTHLY", 1)
    };
    std::fs::write(
        o.client.dir.join("license").join(store::LICENSE_FILE),
        o.vendor.license(&request, &foreign),
    )
    .unwrap();
    assert_eq!(o.client.status(), Status::StateMissing);
    assert!(o.client.manager.refresh_due());

    o.server.set(Behaviour::Down);
    let (view, _) = o.client.manager.refresh_online();
    assert_eq!(view.state, Status::StateMissing);
    assert!(!o.client.can_write());

    o.server.set(Behaviour::Up);
    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    assert_eq!(view.state, Status::Active);
    assert!(o.client.can_write());
}

// 6.3, ONLINE exit: the server's time replaces a high-water mark from a
// clock that once ran ahead.
#[test]
fn a_refresh_lifts_a_clock_rollback() {
    let o = online();
    o.client.machine.set_now(at(START) + Duration::days(20));
    o.client.status();
    o.client.machine.set_now(at(START) + Duration::days(2));
    assert_eq!(o.client.status(), Status::ClockRollback);
    assert!(o.client.manager.refresh_due());

    o.server.set_now(at(START) + Duration::days(2));
    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    assert_eq!(view.state, Status::Active);
}

#[test]
fn offline_and_perpetual_licences_are_never_refreshed_in_the_background() {
    let w = world(at(START));
    w.client.activate(&w.vendor, &Terms::annual(at(START)));
    w.client.machine.advance(Duration::days(300));
    assert!(!w.client.manager.refresh_due());
    assert!(matches!(
        w.client.manager.refresh_online().1,
        Outcome::NotApplicable(_)
    ));
}

// ------------------------------------------------------------------ stage 5

/// Windows reinstalled on the same computer: MachineGuid new, vault gone.
fn reinstall(client: &Client) {
    client.machine.fp.lock().unwrap().mg = "reinstalled".into();
    *client.machine.vault.lock().unwrap() = None;
}

// Test 5, online, and test 24, ONLINE with everything wiped: without network
// read-only; with it the seat rebinds itself and the state is made anew.
#[test]
fn t05_t24_online_reinstall_rebinds_itself() {
    let o = online();
    reinstall(&o.client);
    assert_eq!(o.client.status(), Status::RebindRequired);
    assert!(o.client.manager.refresh_due());

    o.server.set(Behaviour::Down);
    let (view, outcome) = o.client.manager.refresh_online();
    assert!(matches!(outcome, Outcome::Unreachable(_)));
    assert_eq!(view.state, Status::RebindRequired);
    assert!(!o.client.can_write());

    o.server.set(Behaviour::Up);
    let (view, outcome) = o.client.manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    assert_eq!(view.state, Status::Active);
    assert!(view.has_device_key);
    assert!(o.client.can_write());
}

#[test]
fn another_computer_is_never_rebound_automatically() {
    let o = online();
    *o.client.machine.fp.lock().unwrap() = Fingerprint {
        mg: "x".into(),
        smbios: "y".into(),
        disk: "z".into(),
    };
    *o.client.machine.vault.lock().unwrap() = None;
    assert_eq!(o.client.status(), Status::MachineMismatch);
    assert!(!o.client.manager.refresh_due());
    assert!(matches!(
        o.client.manager.refresh_online().1,
        Outcome::NotApplicable(_)
    ));
}

#[test]
fn online_deactivation_removes_the_licence_on_a_signed_answer() {
    let o = online();
    let old = license_file(&o.client);
    let view = o.client.manager.deactivate_online().unwrap();
    assert_eq!(view.state, Status::Unlicensed);
    assert!(!view.has_device_key);
    assert!(o.client.manager.import_bytes(&old).is_err());
}

#[test]
fn online_deactivation_without_a_proper_answer_keeps_the_licence() {
    let o = online();
    for behaviour in [
        Behaviour::Down,
        Behaviour::Status500,
        Behaviour::TransferForeign,
    ] {
        o.server.set(behaviour);
        assert!(o.client.manager.deactivate_online().is_err());
        assert_eq!(o.client.status(), Status::Active);
        assert!(o.client.can_write());
    }
}

/// Over real HTTP: the actual reqwest client against the actual licence
/// server (Node, started here and stopped here). Activation, refresh,
/// revocation. Needs Node 22.18+ on PATH:
///   cargo test --lib e2e_online_over_http -- --ignored
#[cfg(debug_assertions)]
#[test]
#[ignore]
fn e2e_online_over_http() {
    use super::super::client::HttpTransport;
    use std::process::{Command, Stdio};

    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("license.db");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();

    let cli = |args: &[&str]| -> String {
        let output = Command::new("node")
            .current_dir(&repo)
            .arg("tools/hrd-license/cli.js")
            .args(args)
            .args(["--dev", "--db", db.to_str().unwrap()])
            .output()
            .expect("node on PATH");
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    };
    let after = |text: &str, marker: &str| -> String {
        let start = text.find(marker).unwrap() + marker.len();
        text[start..]
            .split_whitespace()
            .next()
            .unwrap()
            .trim_end_matches([':', ','])
            .to_string()
    };

    let customer = after(&cli(&["customer", "--name", "HTTP Ltd."]), "Клиент ");
    let created = cli(&[
        "license",
        "--customer",
        &customer,
        "--plan",
        "MONTHLY",
        "--mode",
        "ONLINE",
    ]);
    let key = after(&created, "показывается один раз): ");
    let license_id = after(&created, "Лицензия ");

    // Only this child is ever stopped - by its own handle.
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _server = Server(
        Command::new("node")
            .current_dir(repo.join("license-server"))
            .arg("src/server.ts")
            .env("PORT", port.to_string())
            .env("HRD_LICENSE_DB", &db)
            .env("HRD_DEV_SIGNING", "1")
            .env("INSECURE_COOKIE", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node on PATH"),
    );
    let started = std::time::Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "server did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::env::set_var(
        "HRD_LICENSE_SERVER_URL",
        format!("http://127.0.0.1:{port}/v1"),
    );

    let machine = Arc::new(FakeMachine::new(Utc::now(), 1));
    let manager = LicenseManager::new(
        temp.path().join("client"),
        machine.clone(),
        KeyRing::embedded(),
        "1.0.0",
        Arc::new(HttpTransport::new("1.0.0").unwrap()),
    );

    let view = manager.activate_online(&key).unwrap();
    assert_eq!(view.state, Status::Active);
    assert_eq!(
        view.license.as_ref().unwrap().activation_mode,
        ActivationMode::Online
    );

    let (view, outcome) = manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    assert_eq!(view.license.unwrap().revision, 2);

    // 7.1 online: Windows reinstalled, the seat rebinds itself.
    machine.fp.lock().unwrap().mg = "reinstalled".into();
    *machine.vault.lock().unwrap() = None;
    assert_eq!(manager.refresh().state, Status::RebindRequired);
    let (view, outcome) = manager.refresh_online();
    assert_eq!(outcome, Outcome::Updated);
    assert_eq!(view.state, Status::Active);

    // 7.2 online: the seat is freed on the server, the licence goes here.
    assert_eq!(
        manager.deactivate_online().unwrap().state,
        Status::Unlicensed
    );

    // A fresh activation, then the seller revokes the licence.
    let view = manager.activate_online(&key).unwrap();
    assert_eq!(view.state, Status::Active);
    cli(&["revoke", "--license-id", &license_id, "--reason", "e2e"]);
    let (view, outcome) = manager.refresh_online();
    assert_eq!(outcome, Outcome::Revoked);
    assert_eq!(view.state, Status::Revoked);
}
