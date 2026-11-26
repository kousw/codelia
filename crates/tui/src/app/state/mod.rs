pub(crate) mod input;
pub(crate) mod log;
pub(crate) mod render;
pub(crate) mod selection;
pub(crate) mod stream_preview;
pub(crate) mod ui;
pub(crate) mod upload;

pub(crate) use crate::app::util::image::PendingImageAttachment;
pub(crate) use input::InputState;
pub(crate) use log::{LogColor, LogKind, LogLine, LogSpan, LogTone};
pub(crate) use render::{
    CursorPhase, PerfDebugStats, RenderState, SelectableFragment, SyncPhase, WrappedLogCache,
    WrappedLogRow,
};
pub(crate) use selection::{
    SelectionHitTest, SelectionProjectionId, SelectionRange, TextSelectionPhase, TranscriptHitMap,
};
pub(crate) use ui::{
    active_skill_mention_token, command_suggestion_rows, complete_skill_mention,
    complete_slash_command, is_known_command, parse_theme_name, skill_suggestion_rows,
    theme_options, unknown_command_message, ConfirmDialogState, ConfirmMode, ConfirmSlot,
    ContextPanelState, LaneListItem, LaneListPanelState, LocalPanel, ModelListMode,
    ModelListPanelState, ModelListSubmitAction, ModelListViewMode, ModelPickerState, ModelSetScope,
    OverlayState, PasteTarget, PickDialogItem, PickDialogState, PromptDialogState, PromptSlot,
    ProviderPickerState, QueueSteerPicker, ReasoningPickerState, RuntimeDialogRef,
    SessionListPanelState, ShellRulePicker, SkillsListItemState, SkillsListPanelState,
    SkillsScopeFilter, StatusLineMode, ThemeListPanelState, ThemeName,
};
