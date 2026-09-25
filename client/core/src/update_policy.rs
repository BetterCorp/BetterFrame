//! Durable, non-secret update preferences; independent of enrollment state.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Window {
    pub day: u8,
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Schedule {
    pub mode: String,
    pub windows: Vec<Window>,
    pub timezone: String,
}

impl Schedule {
    pub fn allows(&self, day: u8, minute: u16) -> bool {
        if self.mode == "always" {
            return true;
        }
        if self.mode != "windows" || day > 6 || minute >= 1440 {
            return false;
        }
        self.windows.iter().any(|window| {
            let (Some(start), Some(end)) = (minutes(&window.start), minutes(&window.end)) else {
                return false;
            };
            if window.day > 6 || start == end {
                return false;
            }
            if start < end {
                window.day == day && minute >= start && minute < end
            } else {
                (window.day == day && minute >= start)
                    || ((window.day + 1) % 7 == day && minute < end)
            }
        })
    }
}

fn minutes(value: &str) -> Option<u16> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    if ![bytes[0], bytes[1], bytes[3], bytes[4]]
        .iter()
        .all(u8::is_ascii_digit)
    {
        return None;
    }
    let hour = (bytes[0] - b'0') as u16 * 10 + (bytes[1] - b'0') as u16;
    let minute = (bytes[3] - b'0') as u16 * 10 + (bytes[4] - b'0') as u16;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Policy {
    pub server: String,
    pub schedule: Schedule,
    pub firmware_channel: String,
    pub firmware_target_version: Option<String>,
    pub os_update_channel: String,
    pub os_update_target_version: Option<String>,
}

impl Policy {
    pub fn selection(&self, os: bool) -> Vec<(String, String)> {
        let (channel, version) = if os {
            (&self.os_update_channel, &self.os_update_target_version)
        } else {
            (&self.firmware_channel, &self.firmware_target_version)
        };
        let mut query = vec![("channel".into(), channel.clone())];
        if let Some(version) = version {
            query.push(("version".into(), version.clone()));
        }
        query
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recurring_windows_include_start_exclude_end_and_wrap_week() {
        let schedule = Schedule {
            mode: "windows".into(),
            timezone: "UTC".into(),
            windows: vec![
                Window {
                    day: 6,
                    start: "23:00".into(),
                    end: "01:00".into(),
                },
                Window {
                    day: 2,
                    start: "02:00".into(),
                    end: "03:00".into(),
                },
            ],
        };
        assert!(schedule.allows(6, 1380));
        assert!(schedule.allows(0, 59));
        assert!(!schedule.allows(0, 60));
        assert!(!schedule.allows(6, 1379));
        assert!(schedule.allows(2, 120));
        assert!(!schedule.allows(2, 180));
        assert!(!schedule.allows(3, 120));
    }
    #[test]
    fn malformed_or_empty_windows_do_not_allow_updates() {
        for start in ["25:00", "1:00", "aa:bb", "01:00"] {
            let schedule = Schedule {
                mode: "windows".into(),
                timezone: "UTC".into(),
                windows: vec![Window {
                    day: 0,
                    start: start.into(),
                    end: "01:00".into(),
                }],
            };
            assert!(!schedule.allows(0, 30));
        }
    }
    #[test]
    fn preferences_and_pins_survive_restart() {
        let policy: Policy = serde_json::from_value(serde_json::json!({
            "server": "https://frame.example", "schedule": {"mode":"always", "windows":[], "timezone":"UTC"},
            "firmware_channel":"beta", "firmware_target_version":"2.0.0",
            "os_update_channel":"dev", "os_update_target_version":null
        })).unwrap();
        let reloaded: Policy =
            serde_json::from_slice(&serde_json::to_vec(&policy).unwrap()).unwrap();
        assert_eq!(
            reloaded.selection(false),
            vec![
                ("channel".into(), "beta".into()),
                ("version".into(), "2.0.0".into())
            ]
        );
        assert_eq!(
            reloaded.selection(true),
            vec![("channel".into(), "dev".into())]
        );
    }
}
