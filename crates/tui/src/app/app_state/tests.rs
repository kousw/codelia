use super::{
    AppState, ConfirmDialogState, ErrorDetailMode, ModelListMode, ModelSetScope, PendingRpcMatch,
    RpcPendingState, SkillsListItemState, SkillsListPanelState, SkillsScopeFilter,
};
use crate::app::state::LogKind;
use crate::app::state::{ConfirmMode, ConfirmPhase, CursorPhase, SyncPhase};

fn sample_panel() -> SkillsListPanelState {
    let mut panel = SkillsListPanelState {
        title: "Skills".to_string(),
        header: String::new(),
        rows: Vec::new(),
        filtered_indices: Vec::new(),
        items: vec![
            SkillsListItemState {
                name: "repo-review".to_string(),
                description: "Review repo changes".to_string(),
                path: "/repo/.agents/skills/repo-review/SKILL.md".to_string(),
                scope: "repo".to_string(),
                enabled: true,
            },
            SkillsListItemState {
                name: "user-helper".to_string(),
                description: "User helper".to_string(),
                path: "/home/user/.agents/skills/user-helper/SKILL.md".to_string(),
                scope: "user".to_string(),
                enabled: false,
            },
        ],
        selected: 0,
        search_query: String::new(),
        scope_filter: SkillsScopeFilter::All,
    };
    panel.rebuild();
    panel
}

#[test]
fn skills_panel_rebuild_filters_by_scope() {
    let mut panel = sample_panel();
    panel.scope_filter = SkillsScopeFilter::Repo;
    panel.rebuild();
    assert_eq!(panel.filtered_indices.len(), 1);
    assert!(panel.rows[0].contains("[repo]"));
}

#[test]
fn skills_panel_rebuild_filters_by_query() {
    let mut panel = sample_panel();
    panel.search_query = "user".to_string();
    panel.rebuild();
    assert_eq!(panel.filtered_indices.len(), 1);
    assert!(panel.rows[0].contains("user-helper"));
}

fn sample_confirm_dialog() -> ConfirmDialogState {
    ConfirmDialogState {
        id: "confirm_1".to_string(),
        title: "Permission".to_string(),
        message: "Allow tool?".to_string(),
        danger_level: None,
        confirm_label: "Allow".to_string(),
        cancel_label: "Deny".to_string(),
        allow_remember: true,
        allow_reason: true,
        command_view: false,
        selected: 0,
        mode: ConfirmMode::Select,
    }
}

#[test]
fn render_state_invariants_hold_for_confirm_request_activation_and_close() {
    let mut app = AppState::default();
    app.render_state.wrapped_total = 12;
    app.render_state.visible_start = 6;
    app.render_state.visible_end = 12;
    app.assert_render_invariants();

    app.pending_confirm_dialog = Some(sample_confirm_dialog());
    app.render_state.confirm_phase = ConfirmPhase::Pending;
    app.assert_render_invariants();

    app.confirm_dialog = app.pending_confirm_dialog.take();
    app.render_state.confirm_phase = ConfirmPhase::Active;
    app.assert_render_invariants();

    app.confirm_dialog = None;
    app.render_state.confirm_phase = ConfirmPhase::None;
    app.request_scrollback_sync();
    assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
    app.assert_render_invariants();
}

#[test]
fn render_state_scenario_tracks_sync_confirm_and_cursor_phases() {
    let mut app = AppState::default();

    // startup first frame
    app.render_state.wrapped_total = 8;
    app.render_state.visible_start = 0;
    app.render_state.visible_end = 8;
    app.assert_render_invariants();

    // append logs -> insertion needed
    app.render_state.wrapped_total = 24;
    app.render_state.visible_start = 10;
    app.render_state.visible_end = 24;
    app.request_scrollback_sync();
    assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
    app.assert_render_invariants();

    // insertion applied once
    app.render_state.inserted_until = app.render_state.visible_start;
    app.render_state.sync_phase = SyncPhase::InsertedNeedsRedraw;
    app.render_state.cursor_phase = CursorPhase::HiddenDuringScrollbackInsert;
    app.assert_render_invariants();

    // follow-up redraw completes cursor restore
    app.render_state.sync_phase = SyncPhase::Idle;
    app.render_state.cursor_phase = CursorPhase::VisibleAtComposer;
    app.assert_render_invariants();

    // confirm pending -> active
    app.pending_confirm_dialog = Some(sample_confirm_dialog());
    app.render_state.confirm_phase = ConfirmPhase::Pending;
    app.assert_render_invariants();
    app.confirm_dialog = app.pending_confirm_dialog.take();
    app.render_state.confirm_phase = ConfirmPhase::Active;
    app.assert_render_invariants();

    // confirm close -> next input cycle
    app.confirm_dialog = None;
    app.render_state.confirm_phase = ConfirmPhase::None;
    app.request_scrollback_sync();
    assert_eq!(app.render_state.sync_phase, SyncPhase::NeedsInsert);
    app.assert_render_invariants();
}

#[test]
fn push_error_report_keeps_summary_compact_by_default() {
    let mut app = AppState::default();
    app.push_error_report("run.start error", "runtime busy");
    assert_eq!(app.log.len(), 1);
    assert_eq!(app.log[0].kind(), LogKind::Error);
    assert!(app.log[0]
        .plain_text()
        .contains("run.start error: runtime busy"));
    assert!(app.log[0].plain_text().contains("wait for the active run"));
    assert!(app.last_error_detail.is_none());
}

#[test]
fn push_error_report_can_expand_multiline_details() {
    let mut app = AppState::default();
    app.set_error_detail_mode(ErrorDetailMode::Detail);
    app.push_error_report(
        "rpc error",
        "invalid params\npath: input.text\nexpected string",
    );

    assert_eq!(app.log[0].kind(), LogKind::Error);
    assert!(app.log[0].plain_text().contains("invalid params"));
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("path: input.text")));
    assert!(app.last_error_detail.is_some());
}

#[test]
fn show_last_error_detail_prints_stored_payload() {
    let mut app = AppState::default();
    app.push_error_report("rpc error", "first line\nsecond line");
    let shown = app.show_last_error_detail();
    assert!(shown);
    assert!(app
        .log
        .iter()
        .any(|line| line.plain_text().contains("second line")));
}

#[test]
fn update_run_status_clears_context_left_on_new_active_run() {
    let mut app = AppState::default();
    app.context_left_percent = Some(96);

    app.update_run_status("starting".to_string());

    assert_eq!(app.context_left_percent, None);
}

#[test]
fn rpc_pending_take_match_prefers_existing_order() {
    let mut pending = RpcPendingState {
        session_list_id: Some("same".to_string()),
        model_list_id: Some("same".to_string()),
        model_list_mode: Some(ModelListMode::List),
        ..Default::default()
    };

    let matched = pending.take_match_for_response("same");
    assert_eq!(matched, Some(PendingRpcMatch::SessionList));
    assert!(pending.session_list_id.is_none());
    assert_eq!(pending.model_list_id.as_deref(), Some("same"));
}

#[test]
fn rpc_pending_take_match_extracts_model_mode_and_clears_it() {
    let mut pending = RpcPendingState {
        model_list_id: Some("m1".to_string()),
        model_list_mode: Some(ModelListMode::List),
        ..Default::default()
    };

    let matched = pending.take_match_for_response("m1");
    assert_eq!(
        matched,
        Some(PendingRpcMatch::ModelList {
            mode: ModelListMode::List,
            scope: ModelSetScope::Config,
        })
    );
    assert!(pending.model_list_id.is_none());
    assert!(pending.model_list_mode.is_none());
    assert!(pending.model_list_scope.is_none());
}
