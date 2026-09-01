use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct OperatorFocusRequest {
    pub display_id: String,
    pub camera_id: String,
    pub stream: String,
    pub cell_id: Option<String>,
    pub fullscreen: bool,
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerCommand {
    ReloadBundle,
    Standby(Option<String>),
    Wake(Option<String>),
    SwitchLayout {
        display_id: Option<String>,
        layout_id: String,
    },
    OperatorFocus(OperatorFocusRequest),
    OperatorClear(String),
    OperatorRestore(String),
    VolumeSet(u32),
    VolumeMute(bool),
    AudioOutputSet(String),
    Reboot,
    TailscaleAuth(String),
    FirmwareCheck {
        force: bool,
    },
    OsCheck {
        force: bool,
    },
    CancelUpdates,
    ShowTerminalCode(String),
    DismissTerminalCode,
}

pub fn decode(text: &str) -> Result<Option<ServerCommand>, serde_json::Error> {
    let message: Value = serde_json::from_str(text)?;
    let id = |name: &str| message.get(name).and_then(flexible_id);
    let command = match message.get("type").and_then(Value::as_str).unwrap_or("") {
        "reload-bundle" => ServerCommand::ReloadBundle,
        "standby" => ServerCommand::Standby(id("display_id")),
        "wake" => ServerCommand::Wake(id("display_id")),
        "layout-switch" => {
            let Some(layout_id) = id("layout_id") else {
                return Ok(None);
            };
            ServerCommand::SwitchLayout {
                display_id: id("display_id"),
                layout_id,
            }
        }
        "operator-focus" => {
            let (Some(display_id), Some(camera_id)) = (id("display_id"), id("camera_id")) else {
                return Ok(None);
            };
            ServerCommand::OperatorFocus(OperatorFocusRequest {
                display_id,
                camera_id,
                stream: message
                    .get("stream")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_string(),
                cell_id: id("cell_id"),
                fullscreen: message
                    .get("fullscreen")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                duration_seconds: message.get("duration_seconds").and_then(Value::as_u64),
            })
        }
        "operator-clear" => {
            let Some(display_id) = id("display_id") else {
                return Ok(None);
            };
            ServerCommand::OperatorClear(display_id)
        }
        "operator-restore" => {
            let Some(display_id) = id("display_id") else {
                return Ok(None);
            };
            ServerCommand::OperatorRestore(display_id)
        }
        "volume-set" => {
            let Some(volume) = message.get("volume").and_then(Value::as_u64) else {
                return Ok(None);
            };
            ServerCommand::VolumeSet(volume.min(100) as u32)
        }
        "volume-mute" => ServerCommand::VolumeMute(
            message
                .get("muted")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
        "audio-output" => {
            let Some(output) = message.get("output_id").and_then(Value::as_str) else {
                return Ok(None);
            };
            ServerCommand::AudioOutputSet(output.to_string())
        }
        "reboot" => ServerCommand::Reboot,
        "tailscale-auth" => {
            let Some(key) = message.get("auth_key").and_then(Value::as_str) else {
                return Ok(None);
            };
            ServerCommand::TailscaleAuth(key.to_string())
        }
        "firmware_check" => ServerCommand::FirmwareCheck {
            force: message
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "os_check" => ServerCommand::OsCheck {
            force: message
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "update_cancel" => ServerCommand::CancelUpdates,
        _ => return Ok(None),
    };
    Ok(Some(command))
}

fn flexible_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_shared_commands_and_rejects_incomplete_messages() {
        assert_eq!(
            decode(r#"{"type":"layout-switch","display_id":2,"layout_id":"7"}"#).unwrap(),
            Some(ServerCommand::SwitchLayout {
                display_id: Some("2".into()),
                layout_id: "7".into()
            })
        );
        assert_eq!(
            decode(r#"{"type":"volume-set","volume":101}"#).unwrap(),
            Some(ServerCommand::VolumeSet(100))
        );
        assert_eq!(decode(r#"{"type":"layout-switch"}"#).unwrap(), None);
    }
}
