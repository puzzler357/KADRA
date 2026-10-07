//! Clock rollback protection (6): the highest time this device has seen, and
//! the limits on what may raise it.
//!
//! Pure rules over `PersistedState`; where the state lives is `store.rs`.

use chrono::{DateTime, Duration, Utc};

use super::model::PersistedState;

/// Rollback allowed before it counts (2.2 `clock_tolerance_hours`): time
/// zones, a drained BIOS battery.
pub fn tolerance() -> Duration {
    Duration::hours(48)
}

/// How far above the trusted high-water mark an audit-log anchor may sit
/// (6.1). Above that it is a wrong clock or a forgery, not evidence.
pub fn anchor_ceiling() -> Duration {
    Duration::days(400)
}

/// How often the running app writes the current time down (6).
pub fn tick_interval() -> std::time::Duration {
    std::time::Duration::from_secs(30 * 60)
}

/// Raises the mark to `now`. Never lowers it: a clock set back leaves the
/// mark where it was, which is what `is_rollback` then catches.
pub fn tick(state: &mut PersistedState, now: DateTime<Utc>) -> bool {
    if now > state.high_water {
        state.high_water = now;
        true
    } else {
        false
    }
}

/// 6.3: `now < high_water − 48 h` or `now < issued_at − 48 h`.
pub fn is_rollback(
    now: DateTime<Utc>,
    high_water: DateTime<Utc>,
    issued_at: DateTime<Utc>,
) -> bool {
    now < high_water - tolerance() || now < issued_at - tolerance()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorOutcome {
    Raised,
    NotHigher,
    /// Above the ceiling; ignored and journalled as an anomaly.
    Rejected,
}

/// Applies the audit-log anchor the shell reads from the database (6.1).
///
/// The ceiling is counted from the *growing* high-water mark (itself kept up
/// by `tick` every 30 minutes), not from the fixed `issued_at`. From
/// `issued_at` alone, every ordinary row would exceed the ceiling 400 days
/// after a perpetual licence was issued: the anchor would stop working and
/// each routine action would be logged as an anomaly (test 29).
pub fn apply_anchor(
    state: &mut PersistedState,
    anchor: DateTime<Utc>,
    issued_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> AnchorOutcome {
    let trusted = issued_at.map_or(state.high_water, |issued| state.high_water.max(issued));
    let ceiling = trusted + anchor_ceiling();

    if anchor > ceiling {
        state.record_anomaly(
            now,
            "ANCHOR_ABOVE_CEILING",
            format!("audit_log anchor {anchor} is above the ceiling {ceiling}; ignored"),
        );
        return AnchorOutcome::Rejected;
    }

    if anchor > state.high_water {
        state.high_water = anchor;
        AnchorOutcome::Raised
    } else {
        AnchorOutcome::NotHigher
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn tick_never_lowers() {
        let mut state = PersistedState::new(at("2026-10-10T00:00:00Z"));
        assert!(!tick(&mut state, at("2026-10-01T00:00:00Z")));
        assert_eq!(state.high_water, at("2026-10-10T00:00:00Z"));
        assert!(tick(&mut state, at("2026-10-11T00:00:00Z")));
    }

    #[test]
    fn rollback_within_tolerance_is_not_rollback() {
        let hw = at("2026-10-10T12:00:00Z");
        let issued = at("2026-09-01T00:00:00Z");
        assert!(!is_rollback(hw - Duration::days(1), hw, issued));
        assert!(is_rollback(hw - Duration::days(3), hw, issued));
        assert!(is_rollback(issued - Duration::days(3), issued, issued));
    }

    #[test]
    fn anchor_only_raises() {
        let now = at("2026-10-10T00:00:00Z");
        let mut state = PersistedState::new(now);
        assert_eq!(
            apply_anchor(&mut state, now - Duration::days(1), None, now),
            AnchorOutcome::NotHigher
        );
        assert_eq!(state.high_water, now);
    }

    // Test 29: two years of a perpetual licence, ordinary rows keep counting.
    #[test]
    fn ceiling_moves_with_the_high_water_mark() {
        let issued = at("2026-01-01T00:00:00Z");
        let mut state = PersistedState::new(issued);
        let mut now = issued;

        for _ in 0..(2 * 365) {
            now += Duration::days(1);
            tick(&mut state, now);
            let outcome = apply_anchor(&mut state, now - Duration::minutes(5), Some(issued), now);
            assert_ne!(outcome, AnchorOutcome::Rejected, "rejected on {now}");
        }
        assert!(state.anomalies.is_empty());
        assert!(!is_rollback(now, state.high_water, issued));
    }
}
