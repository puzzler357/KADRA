//! The online exchange with the licence server (5.2).
//!
//! Two rules shape everything here:
//!
//! - A network failure changes nothing (2.4). Timeouts, refused connections,
//!   5xx and even unsigned 4xx answers leave the licence as it was; the client
//!   keeps working until `lease_until` and tries again later.
//! - Only a signed answer changes the state: a new licence file, or a signed
//!   REVOKED / TRANSFERRED that echoes the nonce of this very request.

use std::time::Duration;

use serde::Deserialize;

use super::device_key::DeviceKey;
use super::files::OpResult;
use super::model::{
    ActivationMode, Envelope, LicensePayload, RequestPayload, RequestType, StatusKind,
};
use super::state::Status;
use super::store::Stored;
use super::verify::{self, Signed};
use super::{clock, lock, LicenseManager, StatusView};

/// Compiled in from the environment of a release build (build.rs insists
/// on it there). A licence may override it with its signed `server_url`.
const BUILT_IN_SERVER: Option<&str> = option_env!("LICENSE_SERVER_URL");
/// 5.2: the background check runs this often, and no more.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);

/// Debug builds talk to a licence server on this machine.
const DEBUG_SERVER: &str = "http://127.0.0.1:8787/v1";

pub fn server_url(license: Option<&LicensePayload>) -> Option<String> {
    // Debug builds only: point at a test server without rebuilding.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("KDR_LICENSE_SERVER_URL") {
        return Some(url.trim_end_matches('/').to_string());
    }
    let url = license
        .and_then(|l| l.server_url.clone())
        .or_else(|| BUILT_IN_SERVER.map(String::from))
        .or_else(|| cfg!(debug_assertions).then(|| DEBUG_SERVER.to_string()))?;
    Some(url.trim_end_matches('/').to_string())
}

pub struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}

/// How requests reach the server. `Err` means no answer at all.
pub trait Transport: Send + Sync {
    fn post(&self, url: &str, body: &[u8]) -> Result<HttpReply, String>;
}

/// HTTPS over rustls, certificates checked against the Windows store, the
/// system proxy honoured, no pinning (5.2: a routine certificate change must
/// not cut every client off).
pub struct HttpTransport {
    client: reqwest::blocking::Client,
}

impl HttpTransport {
    pub fn new(app_version: &str) -> Result<Self, String> {
        // One process-wide provider; a second install is harmless and ignored.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent(format!("KADRA/{app_version}"))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

impl Transport for HttpTransport {
    fn post(&self, url: &str, body: &[u8]) -> Result<HttpReply, String> {
        // The blocking client must not run inside the async runtime that
        // Tauri's commands use, so each exchange gets a plain thread.
        let client = self.client.clone();
        let url = url.to_string();
        let body = body.to_vec();
        std::thread::spawn(move || {
            let response = client
                .post(&url)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .map_err(describe)?;
            let status = response.status().as_u16();
            let body = response.bytes().map_err(describe)?.to_vec();
            Ok(HttpReply { status, body })
        })
        .join()
        .map_err(|_| "сбой сетевого потока".to_string())?
    }
}

/// What went wrong, in words the user can act on. reqwest's own message
/// ("error sending request for url ...") says neither what nor why.
fn describe(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "сервер не ответил вовремя".into()
    } else if error.is_connect() {
        // No route, refused, DNS, or the TLS handshake failed; the source says which.
        match std::error::Error::source(&error).map(|source| source.to_string()) {
            Some(detail) if detail.to_lowercase().contains("certificate") => {
                "сертификат сервера не прошёл проверку".into()
            }
            _ => "сервер не отвечает — проверьте подключение к интернету".into(),
        }
    } else {
        error.to_string()
    }
}

/// Used when no transport could be built: every exchange is "no network".
pub struct Offline;

impl Transport for Offline {
    fn post(&self, _: &str, _: &[u8]) -> Result<HttpReply, String> {
        Err("сетевой клиент недоступен".into())
    }
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    license: Option<Envelope>,
    #[serde(default)]
    status: Option<Envelope>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// What an online check came to, for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Updated,
    Revoked,
    Transferred,
    /// No answer, or a 5xx: nothing changed, retried later.
    Unreachable(String),
    /// An unsigned refusal: nothing changed.
    Refused(String),
    /// Nothing to ask the server for.
    NotApplicable(String),
}

impl Outcome {
    pub fn message(&self) -> String {
        match self {
            Outcome::Updated => "Лицензия обновлена с сервера".into(),
            Outcome::Revoked => "Сервер сообщил, что лицензия отозвана".into(),
            Outcome::Transferred => "Место этого компьютера передано другому устройству".into(),
            Outcome::Unreachable(why) => {
                format!("Сервер лицензий недоступен ({why}). Работа продолжается, повторная попытка позже")
            }
            Outcome::Refused(why) => format!("Сервер отклонил запрос: {why}"),
            Outcome::NotApplicable(why) => why.clone(),
        }
    }
}

enum Answer {
    Signed(Vec<u8>, Signed),
    Unreachable(String),
    Refused(String),
}

impl LicenseManager {
    fn exchange(&self, url: &str, request: &super::model::SignedRequest) -> Answer {
        let body = serde_json::to_vec(request).expect("request serialises");
        let reply = match self.transport.post(url, &body) {
            Ok(reply) => reply,
            Err(error) => return Answer::Unreachable(error),
        };
        if reply.status >= 500 {
            return Answer::Unreachable(format!("код {}", reply.status));
        }
        let parsed: Option<Reply> = serde_json::from_slice(&reply.body).ok();
        if reply.status != 200 {
            let why = parsed
                .and_then(|r| r.message.or(r.error))
                .unwrap_or_else(|| format!("код {}", reply.status));
            return Answer::Refused(why);
        }
        let Some(reply) = parsed else {
            return Answer::Unreachable("непонятный ответ".into());
        };
        let Some(envelope) = reply.license.or(reply.status) else {
            return Answer::Unreachable("пустой ответ".into());
        };
        let bytes = serde_json::to_vec(&envelope).expect("envelope serialises");
        match verify::verify(&bytes, &self.ring) {
            Ok(signed) => Answer::Signed(bytes, signed),
            // An answer that fails the signature is no answer: 2.4.
            Err(error) => Answer::Unreachable(format!("подпись ответа: {error}")),
        }
    }

    /// Makes the device key if needed, counts the request and saves that
    /// before anything leaves the machine: a counter must never be reused.
    fn prepare(
        &self,
        kind: RequestType,
        license_key: Option<String>,
        license: Option<&LicensePayload>,
        require_key: bool,
    ) -> OpResult<(RequestPayload, super::model::SignedRequest)> {
        let _op = lock(&self.op);
        let now = self.platform.now();
        let mut stored = self.store.load().unwrap_or_else(|| Stored::fresh(now));
        if stored.device.is_none() {
            if require_key {
                return Err(
                    "На этом компьютере нет ключа устройства: нужна повторная привязка".into(),
                );
            }
            stored.device = Some(DeviceKey::generate());
        }
        clock::tick(&mut stored.state, now);
        let request = self.build_request(&mut stored, kind, license_key, license, now);
        let signed = stored.device.as_ref().unwrap().sign_request(&request);
        self.store.save(&stored)?;
        Ok((request, signed))
    }

    /// 5.2 `/v1/activate`: activation by key over the network.
    pub fn activate_online(&self, license_key: &str) -> OpResult<StatusView> {
        let key = license_key.trim().to_uppercase();
        if key.is_empty() {
            return Err("Введите ключ лицензии".into());
        }
        let url = server_url(None).ok_or("Адрес сервера лицензий не задан в этой сборке")?;
        let (_, signed) = self.prepare(RequestType::Activate, Some(key), None, false)?;

        match self.exchange(&format!("{url}/activate"), &signed) {
            Answer::Signed(bytes, Signed::License(license)) => {
                let _op = lock(&self.op);
                self.install_license(&bytes, license, true)?;
                Ok(self.refresh_locked())
            }
            Answer::Signed(..) => Err("Сервер ответил не файлом лицензии".into()),
            Answer::Unreachable(why) => Err(format!(
                "Нет связи с сервером лицензий ({why}). Можно активировать обменом файлами."
            )),
            Answer::Refused(why) => Err(why),
        }
    }

    /// Whether the background check should ask the server now (5.2): an
    /// ONLINE licence past `refresh_after`, or one whose state needs the
    /// server to be restored (6.2, 6.3).
    pub fn refresh_due(&self) -> bool {
        let Some(license) = self.installed_license() else {
            return false;
        };
        if license.activation_mode != ActivationMode::Online {
            return false;
        }
        let now = self.platform.now();
        let state = self.status().state;
        license.refresh_after.is_some_and(|after| now >= after)
            || matches!(
                state,
                Status::StateMissing
                    | Status::ClockRollback
                    | Status::LeaseExpired
                    | Status::RebindRequired
            )
    }

    /// 5.2 `/v1/refresh`. Never makes things worse: only a signed answer for
    /// this request changes anything.
    pub fn refresh_online(&self) -> (StatusView, Outcome) {
        let outcome = self.refresh_exchange();
        (self.refresh(), outcome)
    }

    fn refresh_exchange(&self) -> Outcome {
        let Some(license) = self.installed_license() else {
            return Outcome::NotApplicable("Лицензия не установлена".into());
        };
        if license.activation_mode != ActivationMode::Online {
            return Outcome::NotApplicable(
                "Офлайн-лицензия продлевается файлом от продавца".into(),
            );
        }
        let Some(url) = server_url(Some(&license)) else {
            return Outcome::NotApplicable("Адрес сервера лицензий не задан в этой сборке".into());
        };
        let key_matches = self
            .store
            .load()
            .and_then(|s| s.device.map(|d| d.public_b64()))
            .is_some_and(|key| key == license.activation.device_pubkey);
        if !key_matches {
            return self.rebind_exchange(&license, &url);
        }

        let (request, signed) = match self.prepare(RequestType::Refresh, None, Some(&license), true)
        {
            Ok(prepared) => prepared,
            Err(error) => return Outcome::Refused(error),
        };

        match self.exchange(&format!("{url}/refresh"), &signed) {
            Answer::Unreachable(why) => Outcome::Unreachable(why),
            Answer::Refused(why) => Outcome::Refused(why),
            Answer::Signed(bytes, Signed::License(fresh)) => {
                let _op = lock(&self.op);
                match self.install_license(&bytes, fresh, true) {
                    Ok(()) => Outcome::Updated,
                    Err(why) => Outcome::Refused(why),
                }
            }
            Answer::Signed(_, Signed::Status(status)) => {
                let kind = status.kind;
                match self.accept_server_status(&status, &request.nonce) {
                    Ok(_) if kind == StatusKind::Revoked => Outcome::Revoked,
                    Ok(_) => Outcome::Transferred,
                    Err(why) => Outcome::Refused(why),
                }
            }
        }
    }
}

impl LicenseManager {
    /// 7.1, online: the same computer lost its device key (a reinstall) but
    /// still matches two of three fingerprint components. A new key is made
    /// and the server binds the seat to it; not a transfer. Another computer
    /// (MACHINE_MISMATCH) never gets here - that needs the seller.
    fn rebind_exchange(&self, license: &LicensePayload, url: &str) -> Outcome {
        let threshold = license.activation.fp_threshold.max(1);
        if self.platform.fingerprint().matches(&license.activation.fp) < threshold {
            return Outcome::NotApplicable("Лицензия выпущена для другого компьютера".into());
        }
        let (request, signed) = match self.prepare(RequestType::Rebind, None, Some(license), false)
        {
            Ok(prepared) => prepared,
            Err(error) => return Outcome::Refused(error),
        };
        match self.exchange(&format!("{url}/rebind"), &signed) {
            Answer::Unreachable(why) => Outcome::Unreachable(why),
            Answer::Refused(why) => Outcome::Refused(why),
            Answer::Signed(bytes, Signed::License(fresh)) => {
                let _op = lock(&self.op);
                match self.install_license(&bytes, fresh, true) {
                    Ok(()) => Outcome::Updated,
                    Err(why) => Outcome::Refused(why),
                }
            }
            Answer::Signed(_, Signed::Status(status)) => {
                let kind = status.kind;
                match self.accept_server_status(&status, &request.nonce) {
                    Ok(_) if kind == StatusKind::Revoked => Outcome::Revoked,
                    Ok(_) => Outcome::Transferred,
                    Err(why) => Outcome::Refused(why),
                }
            }
        }
    }

    /// 7.2, online: the server frees the seat, and only its signed answer to
    /// this request removes the licence and the key here.
    pub fn deactivate_online(&self) -> OpResult<StatusView> {
        let license = self
            .installed_license()
            .ok_or("Нет установленной лицензии")?;
        let url =
            server_url(Some(&license)).ok_or("Адрес сервера лицензий не задан в этой сборке")?;
        let key_matches = self
            .store
            .load()
            .and_then(|s| s.device.map(|d| d.public_b64()))
            .is_some_and(|key| key == license.activation.device_pubkey);
        if !key_matches {
            return Err(
                "Ключ этого устройства не совпадает с лицензией; деактивация невозможна".into(),
            );
        }
        let (request, signed) =
            self.prepare(RequestType::Deactivate, None, Some(&license), true)?;

        match self.exchange(&format!("{url}/deactivate"), &signed) {
            Answer::Signed(_, Signed::Status(status)) if status.kind == StatusKind::Transferred => {
                if status.nonce.as_deref() != Some(request.nonce.as_str())
                    || status.license_id != license.license_id
                    || status.activation_id != license.activation.activation_id
                {
                    return Err("Ответ сервера не относится к этому запросу".into());
                }
                let _op = lock(&self.op);
                let mut stored = self.store.load().ok_or("Хранилище лицензии недоступно")?;
                self.finish_deactivation(&mut stored, &license)?;
                Ok(self.refresh_locked())
            }
            Answer::Signed(..) => Err("Сервер ответил не подтверждением деактивации".into()),
            Answer::Unreachable(why) => Err(format!(
                "Нет связи с сервером лицензий ({why}). Можно сохранить файл подтверждения и передать его продавцу."
            )),
            Answer::Refused(why) => Err(why),
        }
    }
}

/// A transport for the tests: a closure plays the server.
#[cfg(test)]
pub struct FakeTransport {
    pub handler: std::sync::Mutex<Box<dyn FnMut(&str, &[u8]) -> Result<HttpReply, String> + Send>>,
}

#[cfg(test)]
impl FakeTransport {
    pub fn new(
        handler: impl FnMut(&str, &[u8]) -> Result<HttpReply, String> + Send + 'static,
    ) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            handler: std::sync::Mutex::new(Box::new(handler)),
        })
    }
}

#[cfg(test)]
impl Transport for FakeTransport {
    fn post(&self, url: &str, body: &[u8]) -> Result<HttpReply, String> {
        (self.handler.lock().unwrap())(url, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_that_is_not_there_is_described_in_plain_words() {
        // A port just released: nothing listens on it.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = HttpTransport::new("test")
            .unwrap()
            .post(&format!("http://127.0.0.1:{port}/v1/refresh"), b"{}")
            .err()
            .expect("nothing listens there");
        assert_eq!(
            error,
            "сервер не отвечает — проверьте подключение к интернету"
        );
    }
}
