use serde::Deserialize;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    SetMouseCapture(bool),
    WriteClipboard { text: String },
    StartClipboardImport,
    StartUpdateControl(UpdateControlAction),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpdateControlAction {
    Status,
    Save(UpdateMode),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateMode {
    Notify,
    Auto,
    Off,
}
