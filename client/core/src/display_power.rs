//! Presentation helpers shared by kiosk sleep screens.
/// Reflect continuously at both edges, including after a long suspended frame.
pub fn bounce_position(elapsed_seconds: f64, speed: f64, extent: f64) -> f64 {
    if extent <= 0.0 {
        return 0.0;
    }
    let phase = (elapsed_seconds * speed).rem_euclid(2.0 * extent);
    extent - (phase - extent).abs()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logo_reflects_at_edges_and_stays_on_resized_screen() {
        assert_eq!(bounce_position(0.0, 10.0, 100.0), 0.0);
        assert_eq!(bounce_position(10.0, 10.0, 100.0), 100.0);
        assert_eq!(bounce_position(11.0, 10.0, 100.0), 90.0);
        assert_eq!(bounce_position(20.0, 10.0, 100.0), 0.0);
        assert_eq!(bounce_position(1000.0, 10.0, 0.0), 0.0);
        for second in 0..10000 {
            assert!((0.0..=13.0).contains(&bounce_position(second as f64, 17.0, 13.0)));
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum IdleDecision {
    None,
    ReturnToDefault,
    Sleep,
}

pub fn idle_decision(
    elapsed: std::time::Duration,
    asleep: bool,
    sleep_seconds: u32,
    idle_seconds: u32,
    can_return: bool,
) -> IdleDecision {
    if asleep {
        return IdleDecision::None;
    }
    if sleep_seconds > 0 && elapsed >= std::time::Duration::from_secs(sleep_seconds as u64) {
        IdleDecision::Sleep
    } else if can_return
        && idle_seconds > 0
        && elapsed >= std::time::Duration::from_secs(idle_seconds as u64)
    {
        IdleDecision::ReturnToDefault
    } else {
        IdleDecision::None
    }
}

#[cfg(test)]
mod idle_tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn sixty_second_sleep_is_independent_of_idle_reversion() {
        assert_eq!(
            idle_decision(Duration::from_millis(59_999), false, 60, 30, true),
            IdleDecision::ReturnToDefault
        );
        // Reverting/rendering the default does not reset elapsed activity.
        assert_eq!(
            idle_decision(Duration::from_secs(60), false, 60, 30, false),
            IdleDecision::Sleep
        );
        assert_eq!(
            idle_decision(Duration::from_secs(60), false, 60, 60, true),
            IdleDecision::Sleep
        );
        assert_eq!(
            idle_decision(Duration::from_secs(65), true, 60, 30, true),
            IdleDecision::None
        );
        assert_eq!(
            idle_decision(Duration::from_secs(65), false, 0, 0, true),
            IdleDecision::None
        );
        assert_eq!(
            idle_decision(Duration::ZERO, false, 60, 30, false),
            IdleDecision::None
        );
    }
}
