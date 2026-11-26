pub(crate) mod frame;
#[cfg(test)]
mod frame_tests;

pub(crate) mod goal;
pub(crate) mod handlers;
pub(crate) mod image_preview;
pub(crate) mod log_wrap;
pub(crate) mod markdown;
pub(crate) mod render;
pub(crate) mod runtime;
pub(crate) mod self_update;
pub(crate) mod startup_confirmations;
pub(crate) mod state;
pub(crate) mod theme;
pub(crate) mod transcript;
pub(crate) mod util;
pub(crate) mod view;

mod app_state;

pub(crate) use app_state::{PendingRpc, PendingRpcSlot};

pub(crate) use crate::app::state::{
    ConfirmDialogState, ConfirmMode, ConfirmSlot, ContextPanelState, CursorPhase, LaneListItem,
    LaneListPanelState, LocalPanel, ModelListMode, ModelListPanelState, ModelListViewMode,
    ModelPickerState, ModelSetScope, OverlayState, PasteTarget, PickDialogItem, PromptDialogState,
    PromptSlot, ProviderPickerState, QueueSteerPicker, ReasoningPickerState, RuntimeDialogRef,
    RuntimePickDialog, RuntimePickList, RuntimePickListKind, SelectionProjectionId, SelectionRange,
    SessionListPanelState, SkillsListItemState, SkillsListPanelState, SkillsScopeFilter,
    StatusLineMode, SyncPhase, ThemeListPanelState, TranscriptHitMap, WrappedLogCache,
    WrappedLogRow,
};
pub(crate) use app_state::{
    ActiveRunSubmitMode, AppState, ErrorDetailMode, InFlightSteer, LogComponentSpan, ModelFastMode,
    PendingPromptRun, PendingShellResult, PermissionPreviewRecord, PROMPT_DISPATCH_MAX_ATTEMPTS,
    PROMPT_DISPATCH_RETRY_BACKOFF,
};
