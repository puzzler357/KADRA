//! The file exchange (5.1, 5.3, 7.2): `.hrdreq` out, `.hrdlic` and `.hrdclock`
//! in, `.hrddeact` out. The same checks apply whether a licence came from the
//! network or from a USB stick - there is one install path.

use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};

use super::clock;
use super::device_key::{self, DeviceKey};
use super::model::{
    Deactivated, LicensePayload, RequestPayload, RequestType, SignedStatus, StatusKind, Track,
};
use super::store::Stored;
use super::verify::{self, Signed};
use super::{lock, LicenseManager, StatusView};

/// Every licence operation reports failure as a sentence the UI can show.
pub type OpResult<T> = Result<T, String>;

const NO_DEVICE_KEY: &str =
    "На этом компьютере нет ключа устройства. Создайте файл запроса и получите лицензию для него.";

fn require_extension(path: &Path, extension: &str) -> OpResult<()> {
    let matches = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if matches {
        Ok(())
    } else {
        Err(format!("Файл должен иметь расширение .{extension}"))
    }
}

impl LicenseManager {
    pub(super) fn installed_license(&self) -> Option<LicensePayload> {
        self.store
            .license_bytes()
            .and_then(|bytes| verify::verify_license(&bytes, &self.ring).ok())
    }

    pub(super) fn build_request(
        &self,
        stored: &mut Stored,
        kind: RequestType,
        license_key: Option<String>,
        license: Option<&LicensePayload>,
        now: DateTime<Utc>,
    ) -> RequestPayload {
        let device = stored
            .device
            .as_ref()
            .expect("device key ensured by caller");
        stored.state.counter += 1;
        RequestPayload {
            kind,
            license_key,
            license_id: license.map(|l| l.license_id.clone()),
            activation_id: license.map(|l| l.activation.activation_id.clone()),
            current_revision: license.map(|l| l.revision),
            device_name: self.platform.device_name(),
            device_pubkey: device.public_b64(),
            fp: self.platform.fingerprint(),
            app_version: self.app_version.clone(),
            client_time: now,
            counter: stored.state.counter,
            nonce: device_key::nonce(),
        }
    }

    /// Writes an ACTIVATE or REBIND request (5.1) for the vendor.
    ///
    /// Makes the device key if there is none: first activation, or a
    /// reinstalled Windows. The key made here is what the vendor's file will
    /// be bound to.
    pub fn export_request(
        &self,
        kind: RequestType,
        license_key: Option<String>,
        path: &Path,
    ) -> OpResult<StatusView> {
        require_extension(path, "hrdreq")?;
        let _op = lock(&self.op);
        let now = self.platform.now();

        let (license_key, license) = match kind {
            RequestType::Activate => {
                let key = license_key
                    .map(|k| k.trim().to_uppercase())
                    .filter(|k| !k.is_empty())
                    .ok_or("Введите ключ лицензии")?;
                (Some(key), None)
            }
            RequestType::Rebind => {
                let license = self
                    .installed_license()
                    .ok_or("Для повторной привязки нужен установленный файл лицензии")?;
                (None, Some(license))
            }
            _ => return Err("Этот тип запроса создаётся только при обмене с сервером".into()),
        };

        let mut stored = self.store.load().unwrap_or_else(|| Stored::fresh(now));
        if stored.device.is_none() {
            stored.device = Some(DeviceKey::generate());
        }
        clock::tick(&mut stored.state, now);

        let request = self.build_request(&mut stored, kind, license_key, license.as_ref(), now);
        let signed = stored.device.as_ref().unwrap().sign_request(&request);

        // State first: the counter must not be reused if the file write fails
        // after the vendor somehow saw the request.
        self.store.save(&stored)?;
        let json = serde_json::to_vec_pretty(&signed).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| format!("Не удалось записать файл: {e}"))?;

        Ok(self.refresh_locked())
    }

    /// Checks and installs a `.hrdlic` or `.hrdclock`.
    pub fn import(&self, path: &Path) -> OpResult<StatusView> {
        let bytes = fs::read(path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
        self.import_bytes(&bytes)
    }

    pub fn import_bytes(&self, bytes: &[u8]) -> OpResult<StatusView> {
        let _op = lock(&self.op);
        let signed = verify::verify(bytes, &self.ring)
            .map_err(|e| format!("Файл не прошёл проверку: {e}"))?;

        match signed {
            Signed::License(license) => self.install_license(bytes, license, false)?,
            Signed::Status(status) if status.kind == StatusKind::ClockReset => {
                self.apply_clock_reset(status)?
            }
            Signed::Status(_) => {
                return Err(
                    "Статус отзыва или переноса принимается только в ответ на запрос к серверу"
                        .into(),
                )
            }
        }
        Ok(self.refresh_locked())
    }

    /// The one install path (5.1), for a file from a USB stick or from the
    /// server alike. `online`: the file is the server's answer to this
    /// device's own request, so its `issued_at` is the server's clock and
    /// replaces the high-water mark (6.3, the ONLINE exit from rollback).
    pub(super) fn install_license(
        &self,
        bytes: &[u8],
        license: LicensePayload,
        online: bool,
    ) -> OpResult<()> {
        let now = self.platform.now();
        let mut stored = self.store.load().ok_or(NO_DEVICE_KEY)?;
        let device = stored.device.as_ref().ok_or(NO_DEVICE_KEY)?;

        if license.activation.device_pubkey != device.public_b64() {
            return Err("Файл лицензии выпущен для другого устройства".into());
        }
        let threshold = license.activation.fp_threshold.max(1);
        if self.platform.fingerprint().matches(&license.activation.fp) < threshold {
            return Err("Файл лицензии выпущен для другого компьютера".into());
        }

        let same = |license_id: &str, activation_id: &str| {
            license_id == license.license_id && activation_id == license.activation.activation_id
        };
        if let Some(gone) = &stored.state.deactivated {
            if same(&gone.license_id, &gone.activation_id) && license.revision <= gone.revision {
                return Err("Эта активация была деактивирована на этом компьютере".into());
            }
        }

        // 3.2: never go back to an older revision - that is how a revoked or
        // transferred licence would be brought back.
        let track = match stored.state.track.take() {
            Some(track) if same(&track.license_id, &track.activation_id) => {
                if license.revision < track.max_revision {
                    stored.state.track = Some(track.clone());
                    return Err(format!(
                        "Файл устарел: ревизия {}, а на этом компьютере уже была {}",
                        license.revision, track.max_revision
                    ));
                }
                Track {
                    max_revision: track.max_revision.max(license.revision),
                    // A newer file than the revocation means the vendor
                    // reinstated the licence.
                    revoked: track.revoked.filter(|revoked| license.revision <= *revoked),
                    ..track
                }
            }
            _ => Track {
                license_id: license.license_id.clone(),
                activation_id: license.activation.activation_id.clone(),
                max_revision: license.revision,
                revoked: None,
            },
        };
        if track.revoked.is_some() {
            stored.state.track = Some(track);
            return Err("Лицензия отозвана; этот файл её не восстанавливает".into());
        }

        stored.state.track = Some(track);
        stored.state.deactivated = None;
        if online {
            stored.state.high_water = license.issued_at;
            stored.state.last_check = Some(now);
        } else {
            stored.state.high_water = stored.state.high_water.max(license.issued_at);
        }
        clock::tick(&mut stored.state, now);

        self.store.save(&stored)?;
        self.store.write_license(bytes)
    }

    /// 6.3, third exit: the vendor's signed unlock after CLOCK_ROLLBACK. There
    /// is no request to echo a nonce from, so the revision guards it: each
    /// reset must be newer than anything this activation has seen.
    fn apply_clock_reset(&self, status: SignedStatus) -> OpResult<()> {
        let license = self
            .installed_license()
            .ok_or("Сначала нужна установленная лицензия")?;
        if status.license_id != license.license_id
            || status.activation_id != license.activation.activation_id
        {
            return Err("Файл разблокировки выпущен для другой лицензии".into());
        }
        let high_water_to = status
            .high_water_to
            .ok_or("В файле разблокировки нет новой отметки времени")?;

        let mut stored = self.store.load().ok_or(NO_DEVICE_KEY)?;
        let now = self.platform.now();
        let track = stored
            .state
            .track
            .as_mut()
            .filter(|t| {
                t.license_id == status.license_id && t.activation_id == status.activation_id
            })
            .ok_or("Состояние лицензии не найдено; нужен новый файл лицензии")?;
        if status.revision <= track.max_revision {
            return Err("Этот файл разблокировки уже использован или устарел".into());
        }
        track.max_revision = status.revision;
        stored.state.high_water = high_water_to;
        stored.state.record_anomaly(
            now,
            "CLOCK_RESET",
            format!(
                "high_water set to {high_water_to} by revision {}",
                status.revision
            ),
        );
        clock::tick(&mut stored.state, now);
        self.store.save(&stored)
    }

    /// A REVOKED or TRANSFERRED answer from the server (3.4, 5.2). Accepted
    /// only for this activation, not older than what was seen, and carrying
    /// the nonce of the request it answers - otherwise an old answer could be
    /// replayed.
    pub fn accept_server_status(
        &self,
        status: &SignedStatus,
        sent_nonce: &str,
    ) -> OpResult<StatusView> {
        let _op = lock(&self.op);
        if status.nonce.as_deref() != Some(sent_nonce) {
            return Err("Ответ сервера не относится к этому запросу".into());
        }
        let mut stored = self.store.load().ok_or(NO_DEVICE_KEY)?;
        let track = stored
            .state
            .track
            .as_mut()
            .filter(|t| {
                t.license_id == status.license_id && t.activation_id == status.activation_id
            })
            .ok_or("Ответ сервера относится к другой активации")?;
        if status.revision < track.max_revision {
            return Err("Ответ сервера устарел".into());
        }
        track.max_revision = status.revision;

        match status.kind {
            StatusKind::Revoked => track.revoked = Some(status.revision),
            StatusKind::Transferred => {
                stored.state.track = None;
                stored.device = None;
                self.store.remove_license()?;
            }
            StatusKind::ClockReset => return Err("Разблокировка часов приходит файлом".into()),
        }
        stored.state.last_check = Some(self.platform.now());
        self.store.save(&stored)?;
        Ok(self.refresh_locked())
    }

    /// Offline deactivation (7.2): a proof signed by the device key, then the
    /// licence and the key are removed. The proof is a DEACTIVATE request, so
    /// the server reads it with the same code as every other request.
    pub fn deactivate(&self, path: &Path) -> OpResult<StatusView> {
        require_extension(path, "hrddeact")?;
        let _op = lock(&self.op);
        let now = self.platform.now();
        let license = self
            .installed_license()
            .ok_or("Нет установленной лицензии")?;
        let mut stored = self.store.load().ok_or(NO_DEVICE_KEY)?;
        let device_matches = stored
            .device
            .as_ref()
            .is_some_and(|d| d.public_b64() == license.activation.device_pubkey);
        if !device_matches {
            return Err(
                "Ключ этого устройства не совпадает с лицензией; деактивация невозможна".into(),
            );
        }

        let request = self.build_request(
            &mut stored,
            RequestType::Deactivate,
            None,
            Some(&license),
            now,
        );
        let proof = stored.device.as_ref().unwrap().sign_request(&request);
        let json = serde_json::to_vec_pretty(&proof).map_err(|e| e.to_string())?;
        // The proof is written before anything is removed: without it the
        // vendor cannot free the seat.
        fs::write(path, json).map_err(|e| format!("Не удалось записать файл: {e}"))?;

        self.finish_deactivation(&mut stored, &license)?;
        Ok(self.refresh_locked())
    }

    /// 7.2: the licence and the device key go; a mark stays, so this very
    /// file cannot be imported again.
    pub(super) fn finish_deactivation(
        &self,
        stored: &mut Stored,
        license: &LicensePayload,
    ) -> OpResult<()> {
        stored.state.deactivated = Some(Deactivated {
            license_id: license.license_id.clone(),
            activation_id: license.activation.activation_id.clone(),
            revision: license.revision,
        });
        stored.state.track = None;
        stored.device = None;
        self.store.save(stored)?;
        self.store.remove_license()
    }

    /// 6.1: the newest audit-log row, read by the shell from the database
    /// (lib.rs), never taken from the webview. It may only raise the
    /// high-water mark, and only up to the ceiling.
    pub fn report_time_anchor(&self, iso: &str) -> OpResult<StatusView> {
        let anchor: DateTime<Utc> = iso
            .parse::<DateTime<chrono::FixedOffset>>()
            .map(|t| t.with_timezone(&Utc))
            .map_err(|_| "Неверный формат времени".to_string())?;
        let _op = lock(&self.op);
        if let Some(mut stored) = self.store.load() {
            let issued_at = self.installed_license().map(|l| l.issued_at);
            let now = self.platform.now();
            if clock::apply_anchor(&mut stored.state, anchor, issued_at, now)
                != clock::AnchorOutcome::NotHigher
            {
                self.store.save(&stored)?;
            }
        }
        Ok(self.refresh_locked())
    }
}
