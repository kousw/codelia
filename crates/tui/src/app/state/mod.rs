pub(crate) mod input;
pub(crate) mod log;
pub(crate) mod perf;
pub(crate) mod render;
pub(crate) mod selection;
pub(crate) mod stream_preview;
pub(crate) mod telemetry;
pub(crate) mod ui;
pub(crate) mod upload;

pub(crate) use crate::app::util::image::PendingImageAttachment;
pub(crate) use input::InputState;
pub(crate) use log::{LogColor, LogKind, LogLine, LogSpan, LogTone};
pub(crate) use perf::TuiPerfStore;
pub(crate) use render::{
    CursorPhase, RenderState, SelectableFragment, SyncPhase, WrappedLogCache, WrappedLogRow,
};
pub(crate) use selection::{
    SelectionHitTest, SelectionProjectionId, SelectionRange, TextSelectionPhase, TranscriptHitMap,
};
pub(crate) use telemetry::TelemetryStore;
pub(crate) use ui::{
    active_skill_mention_token, command_suggestion_rows, complete_skill_mention,
    complete_slash_command, is_known_command, parse_theme_name, skill_suggestion_rows,
    theme_options, unknown_command_message, ConfirmDialogState, ConfirmMode, ConfirmSlot,
    ContextPanelState, LaneActionPickerState, LaneListItem, LaneListPanelState, LocalPanel,
    ModelListMode, ModelListPanelState, ModelListViewMode, ModelPickerState, ModelSetScope,
    OverlayState, PasteTarget, PickDialogItem, PromptDialogState, PromptSlot, ProviderPickerState,
    QueueSteerPicker, ReasoningPickerState, RuntimeDialogKind, RuntimePickDialog, RuntimePickList,
    RuntimePickListKind, SessionListPanelState, ShellRulePicker, ShellRulePickerState,
    SkillsListItemState, SkillsListPanelState, SkillsScopeFilter, StatusLineMode,
    ThemeListPanelState, ThemeName, UpdatePickerState, VisibleRuntimeDialogRef,
};
