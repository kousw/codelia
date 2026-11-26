//! Local, launcher-selected confirmations before normal composer dispatch.

use super::{self_update, state::PickDialogState, AppState, PendingRpcSlot};
use std::collections::VecDeque;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupConfirmation {
    UpdateMode,
}

impl StartupConfirmation {
    fn from_id(id: &str) -> Option<Self> {
        match id {
            "update-mode" => Some(Self::UpdateMode),
            _ => None,
        }
    }

    fn picker(self) -> PickDialogState {
        match self {
            Self::UpdateMode => self_update::startup_picker(),
        }
    }

    fn is_saving(self, app: &AppState) -> bool {
        match self {
            Self::UpdateMode => app.pending_update_control.is_some(),
        }
    }

    fn owns_picker(self, panel: &PickDialogState) -> bool {
        match self {
            Self::UpdateMode => self_update::is_startup_picker(panel),
        }
    }
}

#[derive(Default)]
pub(crate) struct StartupConfirmations {
    queue: VecDeque<StartupConfirmation>,
    answered: bool,
}

impl StartupConfirmations {
    pub(crate) fn from_list(ids: &[String]) -> Self {
        let mut phase = Self::default();
        for item in ids.iter().filter_map(|id| StartupConfirmation::from_id(id)) {
            if !phase.queue.contains(&item) {
                phase.queue.push_back(item);
            }
        }
        phase
    }

    pub(crate) fn is_pending(&self) -> bool {
        !self.queue.is_empty()
    }

    pub(crate) fn answer(&mut self, item: StartupConfirmation) {
        if self.queue.front() == Some(&item) {
            self.answered = true;
        }
    }
}

pub(crate) fn poll(app: &mut AppState) -> bool {
    while let Some(item) = app.startup_confirmations.queue.front().copied() {
        if app.startup_confirmations.answered {
            if item.is_saving(app) {
                return false;
            }
            app.startup_confirmations.queue.pop_front();
            app.startup_confirmations.answered = false;
            continue;
        }
        if (app.runtime_dialogs.confirm_state().is_some() || app.runtime_dialogs.prompt.is_some())
            && app
                .runtime_dialogs
                .pick
                .as_ref()
                .is_some_and(|panel| item.owns_picker(panel))
        {
            app.runtime_dialogs.pick = None;
            return true;
        }
        if app.rpc_pending.has_slot(PendingRpcSlot::Initialize)
            || app.rpc_pending.has_slot(PendingRpcSlot::SessionOpen)
            || app.has_interaction_panel()
        {
            return false;
        }
        // A runtime picker may replace this panel; only a local answer advances the queue.
        app.runtime_dialogs.pick = Some(item.picker());
        return true;
    }
    false
}
