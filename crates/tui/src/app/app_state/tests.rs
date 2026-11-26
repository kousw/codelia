use super::{AppState, ErrorDetailMode, PendingRpc, PendingRpcSlot, SkillsListItemState};
use crate::app::state::{
    ConfirmDialogState, ConfirmMode, ConfirmSlot, CursorPhase, SkillsListPanelState,
    SkillsScopeFilter, SyncPhase,
};
use crate::app::state::{LogKind, LogLine};

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
fn clear_log_preserves_pending_and_active_confirm() {
    let mut app = AppState::default();
    app.overlays.runtime_dialogs.confirm = Some(ConfirmSlot::Pending(sample_confirm_dialog()));
    app.clear_log();
    assert!(app.overlays.runtime_dialogs.is_confirm_pending());

    assert!(app.overlays.runtime_dialogs.activate_pending_confirm());
    let (_, input) = app.overlays.runtime_dialogs.active_confirm_mut().unwrap();
    input.set_from("reason");

    app.clear_log();
    let (state, input) = app.overlays.runtime_dialogs.active_confirm().unwrap();
    assert_eq!(state.id, "confirm_1");
    assert_eq!(input.current(), "reason");
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
    app.overlays.runtime_dialogs.confirm = Some(ConfirmSlot::Pending(sample_confirm_dialog()));
    assert!(app.overlays.runtime_dialogs.is_confirm_pending());
    app.assert_render_invariants();
    assert!(app.overlays.runtime_dialogs.activate_pending_confirm());
    assert!(app.overlays.runtime_dialogs.active_confirm().is_some());
    app.assert_render_invariants();

    // confirm close -> next input cycle
    app.overlays.runtime_dialogs.confirm = None;
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
fn update_run_status_retains_metrics_until_new_measurements_arrive() {
    let mut app = AppState::default();
    app.context_left_percent = Some(96);
    app.runtime_info.last_llm_tps = Some(42.25);

    app.update_run_status("starting".to_string());

    assert_eq!(app.context_left_percent, Some(96));
    assert_eq!(app.runtime_info.last_llm_tps, Some(42.25));
}

#[test]
fn clear_log_clears_progress_component_tracking() {
    let mut app = AppState::default();
    app.log.push(LogLine::new(LogKind::Status, "Progress old"));
    app.progress_component_lines.insert("build".to_string(), 0);

    app.clear_log();

    assert!(app.log.is_empty());
    assert!(app.progress_component_lines.is_empty());
}

#[test]
fn clear_log_removes_only_the_pending_image_artifact_slot() {
    let mut app = AppState::default();
    app.rpc_pending.insert(
        "artifact".into(),
        PendingRpc::ImageArtifact {
            artifact_id: "image-id".into(),
            preview_revision: 0,
        },
    );
    app.rpc_pending
        .insert("model".into(), PendingRpc::ImageModelGet);

    app.clear_log();

    assert!(!app.rpc_pending.has_slot(PendingRpcSlot::ImageArtifact));
    assert!(app.rpc_pending.take("artifact").is_none());
    assert!(matches!(
        app.rpc_pending.take("model"),
        Some(PendingRpc::ImageModelGet)
    ));
}

#[test]
fn every_local_panel_blocks_paste() {
    use crate::app::{
        ContextPanelState, LaneListPanelState, LocalPanel, ModelListMode, ModelListPanelState,
        ModelListSubmitAction, ModelListViewMode, ModelPickerState, ModelSetScope, PasteTarget,
        ProviderPickerState, ReasoningPickerState, SessionListPanelState, ThemeListPanelState,
    };
    let panels = [
        LocalPanel::SessionList(SessionListPanelState {
            title: "Sessions".into(),
            header: String::new(),
            rows: vec![],
            session_ids: vec![],
            selected: 0,
            show_all: false,
        }),
        LocalPanel::LaneList(LaneListPanelState {
            title: "Lanes".into(),
            header: String::new(),
            rows: vec![],
            lanes: vec![],
            selected: 0,
        }),
        LocalPanel::Context(ContextPanelState {
            title: "Context".into(),
            header: String::new(),
            rows: vec![],
            selected: 0,
        }),
        LocalPanel::SkillsList(sample_panel()),
        LocalPanel::ThemeList(ThemeListPanelState {
            title: "Themes".into(),
            header: String::new(),
            rows: vec![],
            theme_ids: vec![],
            selected: 0,
        }),
        LocalPanel::ModelList(ModelListPanelState {
            title: "Models".into(),
            header_limits: String::new(),
            rows_limits: vec![],
            header_cost: String::new(),
            rows_cost: vec![],
            model_ids: vec![],
            selected: 0,
            view_mode: ModelListViewMode::Limits,
            submit_action: ModelListSubmitAction::ModelSet {
                scope: ModelSetScope::Config,
            },
        }),
        LocalPanel::ProviderPicker(ProviderPickerState {
            providers: vec!["openai".into()],
            selected: 0,
            mode: ModelListMode::List,
            scope: ModelSetScope::Config,
        }),
        LocalPanel::ModelPicker(ModelPickerState {
            models: vec!["model".into()],
            selected: 0,
        }),
        LocalPanel::ReasoningPicker(ReasoningPickerState {
            provider: Some("openai".into()),
            model: "model".into(),
            scope: ModelSetScope::Config,
            levels: vec!["low".into()],
            selected: 0,
        }),
    ];
    let mut app = AppState::default();
    assert_eq!(app.paste_target(false), PasteTarget::Composer);
    for panel in panels {
        app.overlays.local_panel = Some(panel);
        assert_eq!(app.paste_target(false), PasteTarget::Blocked);
    }
}

#[test]
fn queue_focus_blocks_editor_input_but_allows_queued_dispatch() {
    use crate::app::{PasteTarget, QueueSteerPicker};

    let mut app = AppState::default();
    app.overlays.queue_focus = Some(QueueSteerPicker {
        run_id: "completed-run".into(),
        queue_id: "q1".into(),
    });
    assert!(app.queue_picker_focused());
    assert!(app.has_interaction_panel());
    assert_eq!(app.paste_target(false), PasteTarget::Blocked);
    assert!(crate::app::handlers::can_dispatch_prompt_now(&app));
}
