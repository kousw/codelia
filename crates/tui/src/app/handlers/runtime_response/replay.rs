use super::client_tools::apply_progress;
use crate::app::runtime::ReplayProgressEvent;
use crate::app::AppState;

pub(super) fn apply_replay_progress(app: &mut AppState, progress: ReplayProgressEvent) {
    match progress {
        ReplayProgressEvent::Call {
            run_id,
            tool_call_id,
            args,
        } => {
            app.pending_history_progress
                .insert((run_id, tool_call_id), args);
        }
        ReplayProgressEvent::Result {
            run_id,
            tool_call_id,
            is_error,
        } => {
            if let Some(args) = app
                .pending_history_progress
                .remove(&(run_id.clone(), tool_call_id))
            {
                if !is_error {
                    apply_progress(app, &args, Some(&run_id));
                }
            }
        }
    }
}
