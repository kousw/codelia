//! Headless GPUI interaction checks. No subprocess, real model or OS app is opened.
use super::Desktop;
use crate::{git::GitSnapshot, runtime_adapter::Workspace, state::State};
use gpui_kit::component::input::{InputState, TextareaState};
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AnyWindowHandle, AppContext, Entity, Focusable, Task};
use gpui_kit::{Bounds, Point, TestAppContext, WindowBounds, WindowOptions, px, size};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

fn fixture(cx: &mut TestAppContext, width: f32) -> (AnyWindowHandle, Entity<Desktop>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        Theme::change(ThemeMode::Light, None, cx);
        gpui_kit::open_window(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: Point::default(), size: size(px(width), px(560.)),
            })),
            ..Default::default()
        }, cx, |window, cx| {
            cx.new(|cx| {
                let workspaces = (0..2).map(|index| {
                    let mut state = State::default();
                    state.connected = true; state.model_available = true; state.model_provider="openai".into(); state.model="fixture".into(); state.supports_run_model=true;
state.supports_new_session = true;
                    state.handle(json!({"id":"same-request-id","method":"ui.prompt.request",
                        "params":{"default_value":format!("default-{index}"),"multiline":index == 0,"secret":index == 1}}));
                    Workspace {
                        drafts: None, submitted_draft: None,
                        root: PathBuf::from(format!("/tmp/codelia-ui-test-{index}")),
                        last_task_poll: std::time::Instant::now(), runtime: None,
                        state, git: GitSnapshot::default(), git_loading: false, git_rx: None,
                    }
                }).collect();
                Desktop {
                    workspaces, selected: 0, runtime_options: crate::transport::RuntimeOptions::for_entry(PathBuf::new()),
                    composer: cx.new(|cx| TextareaState::new(window, cx)),
                    answer: cx.new(|cx| InputState::new(window, cx)),
                    answer_multiline: cx.new(|cx| TextareaState::new(window, cx)),
                    expanded: HashSet::new(), show_models: false, show_sidebar: true,
                    collapsed: HashSet::new(), closing: false, draft_restore_after_quit:false, focus: cx.focus_handle(),
                    request_binding: None, scrolls: HashMap::new(), scroll_revisions: HashMap::new(),
                    _poll: Task::ready(()),
                }
            })
        }).expect("headless desktop window")
    })
}

fn answer_id(view: &Entity<Desktop>, cx: &gpui_kit::App) -> gpui_kit::ElementId {
    let desktop = view.read(cx);
    let request = desktop.workspaces[desktop.selected]
        .state
        .request
        .as_ref()
        .unwrap();
    let id = if request.params["multiline"] == true && request.params["secret"] != true {
        desktop.answer_multiline.entity_id()
    } else {
        desktop.answer.entity_id()
    };
    ("input", id).into()
}

#[gpui_kit::test]
fn project_worktree_navigation_is_bounded_and_cannot_create_during_pending_input(
    cx: &mut TestAppContext,
) {
    let (handle, view) = fixture(cx, 760.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            let state = &mut view.workspaces[0].state;
            state.supports_worktrees = true;
            state.worktree_list = Some(json!({"project_id":"fixture","worktrees": (0..24).map(|index| json!({"path":format!("/tmp/日本語-{index}"),"branch":format!("codelia/worktree/長い作業名-{index}"),"available":index != 1,"current":index == 0,"dirty":index == 2,"changed_files":1})).collect::<Vec<_>>()}));
        });
        window.render_frame(cx);
        for id in ["new-worktree", "refresh-worktrees", "new"] {
            let bounds = window.find(id).bounds();
            assert!(bounds.origin.x >= px(0.) && bounds.right() <= px(220.) && bounds.origin.y >= px(0.) && bounds.bottom() <= px(560.), "{id} remains reachable in the narrow window: {bounds:?}");
        }
        let before = view.read(cx).workspaces[0].state.key();
        window.click("new-worktree", cx);
        assert!(!view.read(cx).workspaces[0].state.has_pending("worktree.create"));
        assert_eq!(view.read(cx).workspaces[0].state.key(), before);
        assert!(view.read(cx).workspaces[0].state.connected, "disabled click does not try a transport");
    }).unwrap();
}

#[gpui_kit::test]
fn workspace_switch_restores_runtime_answers_with_colliding_request_ids(cx: &mut TestAppContext) {
    let (handle, view) = fixture(cx, 900.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        window.click(answer_id(&view, cx), cx);
        window.press("cmd-a", cx);
        window.input("途中の回答 日本語", cx);
        window.click(("workspace", 1usize), cx);
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        window.click(answer_id(&view, cx), cx);
        window.press("cmd-a", cx);
        window.input("synthetic private answer", cx);
        window.click(("workspace", 0usize), cx);
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        assert_eq!(
            view.read(cx).answer_multiline.read(cx).value(),
            "途中の回答 日本語"
        );
        // Clearing a default is intentional and must survive another round trip.
        window.click(answer_id(&view, cx), cx);
        window.press("cmd-a", cx);
        window.press("backspace", cx);
        window.click(("workspace", 1usize), cx);
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        assert_eq!(
            view.read(cx).answer.read(cx).value(),
            "synthetic private answer"
        );
        assert_eq!(
            window.find(answer_id(&view, cx)).value(),
            None,
            "masked field must stay masked"
        );
        window.click(("workspace", 0usize), cx);
        view.update(cx, |view, cx| view.poll(window, cx));
        assert_eq!(view.read(cx).answer_multiline.read(cx).value(), "");
    })
    .unwrap();
}

#[gpui_kit::test]
fn narrow_changes_panel_can_close_and_navigation_can_reveal_sessions(cx: &mut TestAppContext) {
    let (handle, view) = fixture(cx, 760.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        window.click("changes", cx);
        assert!(window.try_find(("workspace", 0usize)).is_none());
        assert!(window.find("close-changes").visible());
        let actions = ["navigation", "changes", "send", "close-changes"];
        for id in actions {
            let bounds = window.find(id).bounds();
            assert!(
                bounds.origin.x >= px(0.) && bounds.right() <= px(760.),
                "{id} stays inside the narrow window: {bounds:?}"
            );
        }
        window.click("navigation", cx);
        assert!(window.find(("workspace", 0usize)).visible());
        assert!(view.read(cx).workspaces[0].state.inspector == crate::state::Inspector::None);
        window.click("changes", cx);
        window.click("close-changes", cx);
        assert!(window.find(("workspace", 0usize)).visible());
    })
    .unwrap();
}

#[gpui_kit::test]
fn new_session_focuses_composer_and_preserves_the_previous_unsent_text(cx: &mut TestAppContext) {
    let (handle, view) = fixture(cx, 900.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| view.poll(window, cx));
        window.render_frame(cx);
        let first = view.read(cx).workspaces[0].state.key();
        window.click(("input", view.read(cx).composer.entity_id()), cx);
        window.input("未送信の依頼", cx);
        window.click("new", cx);
        assert_eq!(view.read(cx).composer.read(cx).value(), "");
        assert!(view.read(cx).composer.focus_handle(cx).is_focused(window));
        assert_eq!(
            view.read(cx).workspaces[0].state.conversations[&first].draft,
            "未送信の依頼"
        );
        window.input("second draft", cx);
        window.click(("loaded-thread", 0usize), cx);
        assert_eq!(view.read(cx).composer.read(cx).value(), "未送信の依頼");
        assert!(view.read(cx).composer.focus_handle(cx).is_focused(window));
    })
    .unwrap();
}

#[gpui_kit::test]
fn failed_git_observation_does_not_render_a_clean_working_tree(cx: &mut TestAppContext) {
    let (handle, view) = fixture(cx, 760.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            // Even if old data exists, a failed observation has no valid status.
            view.workspaces[0].git.status = " M previous.txt".into();
            view.workspaces[0].git.error = Some("Git read failed".into());
        });
        window.render_frame(cx);
        window.click("changes", cx);
        assert!(window.find("git-error").visible());
        assert_eq!(window.find("git-error").label(), Some("Git read failed"));
        assert_eq!(
            window.find("changes").label(),
            Some("Close changes · unavailable")
        );
        assert!(window.try_find("git-view").is_none());
        window.click("close-changes", cx);
        assert!(window.find(("workspace", 0usize)).visible());
    })
    .unwrap();
}

#[gpui_kit::test]
fn switching_workspaces_during_run_preserves_drafts_and_routes_output_to_owner(
    cx: &mut TestAppContext,
) {
    let (handle, view) = fixture(cx, 900.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            for workspace in &mut view.workspaces { workspace.state.request = None; }
            let state = &mut view.workspaces[0].state;
            let request = state.start("最初の依頼", "/tmp/codelia-ui-test-0").expect("fresh run");
            state.handle(json!({"id":request["id"],"result":{"run_id":"run-owner","session_id":"thread-owner"}}));
        });
        window.render_frame(cx);
        window.click(("input", view.read(cx).composer.entity_id()), cx);
        window.input("次の依頼 日本語", cx);
        window.click(("workspace", 1usize), cx);
        window.render_frame(cx);
        assert_eq!(view.read(cx).composer.read(cx).value(), "");
        window.click(("input", view.read(cx).composer.entity_id()), cx);
        window.input("別の作業", cx);
        view.update(cx, |view, _| {
            view.workspaces[0].state.handle(json!({"method":"agent.event","params":{"run_id":"run-owner","seq":1,"event":{"type":"final","content":"owner output"}}}));
            view.workspaces[0].state.handle(json!({"method":"run.status","params":{"run_id":"run-owner","status":"completed"}}));
        });
        assert!(view.read(cx).workspaces[1].state.rows().is_empty());
        assert!(!view.read(cx).workspaces[1].state.has_pending("run.start"));
        window.click(("workspace", 0usize), cx);
        window.render_frame(cx);
        assert_eq!(view.read(cx).composer.read(cx).value(), "次の依頼 日本語");
        assert!(view.read(cx).workspaces[0].state.rows().iter().any(|row| row.body.contains("owner output")));
        window.click(("workspace", 1usize), cx);
        assert_eq!(view.read(cx).composer.read(cx).value(), "別の作業");
    }).unwrap();
}

#[gpui_kit::test]
fn recovered_japanese_draft_and_explicit_clear_use_real_background_store(cx: &mut TestAppContext) {
    let base = std::env::temp_dir().join(format!("codelia-draft-ui-{}", uuid::Uuid::new_v4()));
    let root = base.join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let storage = base.join("state/codelia");
    crate::draft_store::seed_test_draft(
        &root,
        &storage,
        crate::drafts::DraftSnapshot {
            selected: "draft-recovered".into(),
            drafts: [(
                "draft-recovered".into(),
                crate::drafts::DraftText {
                    text: "再起動後も未送信 日本語".into(),
                    title: "Recovered".into(),
                },
            )]
            .into(),
        },
    );
    let (handle, view) = fixture(cx, 760.);
    let mut options = crate::transport::RuntimeOptions::for_entry(PathBuf::new());
    options
        .environment
        .insert("CODELIA_LAYOUT".into(), "xdg".into());
    options.environment.insert(
        "XDG_STATE_HOME".into(),
        base.join("state").to_string_lossy().into_owned(),
    );
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            view.workspaces[0].state.request = None;
            view.workspaces[0].root = root.clone();
            view.workspaces[0].drafts =
                Some(crate::draft_controller::Controller::start(root, options));
        });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while view.read(cx).workspaces[0].state.draft_notice.as_deref() != Some("Drafts recovered")
            && std::time::Instant::now() < until
        {
            view.update(cx, |view, cx| view.poll(window, cx));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        window.render_frame(cx);
        assert!(view.read(cx).composer.read(cx).value() == "再起動後も未送信 日本語");
        assert!(view.read(cx).workspaces[0].state.rows().is_empty());
        let bounds = window.find("clear-draft").bounds();
        assert!(bounds.bottom() <= px(560.));
        window.click("clear-draft", cx);
        while view.read(cx).workspaces[0].state.loading && std::time::Instant::now() < until {
            view.update(cx, |view, cx| view.poll(window, cx));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(view.read(cx).composer.read(cx).value().is_empty());
        assert!(view.read(cx).composer.focus_handle(cx).is_focused(window));
        assert!(view.read(cx).workspaces[0].state.draft_notice.as_deref() == Some("Draft saved"));
        assert!(!view.read(cx).workspaces[0].state.has_pending("run.start"));
        view.update(cx, |view, _| {
            assert!(
                view.workspaces[0]
                    .finish_drafts()
                    .unwrap()
                    .join()
                    .unwrap()
                    .is_ok()
            );
        });
    })
    .unwrap();
    std::fs::remove_dir_all(base).unwrap();
}

#[gpui_kit::test]
fn failed_quit_flush_keeps_window_and_input_without_rebinding_storage(cx: &mut TestAppContext) {
    let base = std::env::temp_dir().join(format!("codelia-draft-close-{}", uuid::Uuid::new_v4()));
    let root = base.join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let directory = crate::draft_store::seed_test_draft(
        &root,
        &base.join("state/codelia"),
        crate::drafts::DraftSnapshot {
            selected: "draft-saved".into(),
            drafts: [(
                "draft-saved".into(),
                crate::drafts::DraftText {
                    text: "older saved".into(),
                    title: "Saved".into(),
                },
            )]
            .into(),
        },
    );
    let original = std::fs::read(directory.join("current.json")).unwrap();
    let (handle, view) = fixture(cx, 760.);
    let mut options = crate::transport::RuntimeOptions::for_entry(PathBuf::new());
    options
        .environment
        .insert("CODELIA_LAYOUT".into(), "xdg".into());
    options.environment.insert(
        "XDG_STATE_HOME".into(),
        base.join("state").to_string_lossy().into_owned(),
    );
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            view.workspaces[0].state.request = None;
            view.workspaces[0].root = root.clone();
            view.workspaces[0].drafts =
                Some(crate::draft_controller::Controller::start(root, options));
        });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while view.read(cx).workspaces[0].state.draft_notice.as_deref() != Some("Drafts recovered")
            && std::time::Instant::now() < until
        {
            view.update(cx, |view, cx| view.poll(window, cx));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        window.render_frame(cx);
        window.click(("input", view.read(cx).composer.entity_id()), cx);
        window.press("cmd-a", cx);
        window.input("保存失敗でも保持する入力", cx);
        std::fs::create_dir(directory.join("pending.json")).unwrap();
        view.update(cx, |view, cx| view.request_quit(cx));
        while view.read(cx).closing && std::time::Instant::now() < until {
            view.update(cx, |view, cx| view.poll(window, cx));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        window.render_frame(cx);
        assert!(!view.read(cx).closing);
        assert!(view.read(cx).composer.read(cx).value() == "保存失敗でも保持する入力");
        assert!(
            view.read(cx).workspaces[0]
                .drafts
                .as_ref()
                .unwrap()
                .failed()
        );
        assert!(window.find("quit-without-saving").visible());
        assert!(!view.read(cx).workspaces[0].state.has_pending("run.start"));
        view.update(cx, |view, _| {
            assert!(
                view.workspaces[0]
                    .finish_drafts()
                    .unwrap()
                    .join()
                    .unwrap()
                    .is_err()
            );
        });
    })
    .unwrap();
    assert!(std::fs::read(directory.join("current.json")).unwrap() == original);
    std::fs::remove_dir_all(base).unwrap();
}

#[gpui_kit::test]
fn failed_admission_restores_its_owner_draft_without_overwriting_selected_thread(
    cx: &mut TestAppContext,
) {
    let (handle, view) = fixture(cx, 900.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, _| {
            let ws = &mut view.workspaces[0];
            ws.state.request = None;
            let owner = ws.state.key();
            let text = "rejected request 日本語".to_owned();
            let start = ws.state.start(&text, "/tmp/codelia-ui-test-0").unwrap();
            ws.submitted_draft = Some((start["id"].clone(), owner.clone(), text.clone()));
            ws.state
                .conversations
                .entry("other-session".into())
                .or_default()
                .draft = "other draft".into();
            assert!(ws.state.select_cached("other-session"));
            let (_, visible) = ws.handle_runtime(
                json!({"id":start["id"],"error":{"code":-1,"message":"setup failed"}}),
            );
            assert!(!visible && ws.state.conversations[&owner].draft == text);
            assert!(ws.state.conversation().draft == "other draft");
        });
        view.update(cx, |view, cx| view.restore_draft(window, cx));
        assert!(view.read(cx).composer.read(cx).value() == "other draft");
    })
    .unwrap();
}

#[gpui_kit::test]
fn missing_startup_workspace_keeps_window_usable_without_runtime(cx: &mut TestAppContext) {
    let (handle, view) = fixture(cx, 760.);
    cx.update_window(handle, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.workspaces.clear();
            let missing = std::env::temp_dir()
                .join(format!("codelia-missing-startup-{}", uuid::Uuid::new_v4()));
            view.open_workspace(missing, window, cx);
            view.poll(window, cx);
            view.save_draft(cx);
            view.send_prompt(window, cx);
            assert!(
                view.workspaces.is_empty(),
                "invalid folders never start runtime or draft workers"
            );
        });
        window.render_frame(cx);
        let bounds = window.find("open-startup-workspace").bounds();
        assert!(
            bounds.origin.x >= px(0.)
                && bounds.right() <= px(760.)
                && bounds.origin.y >= px(0.)
                && bounds.bottom() <= px(560.)
        );
        view.update(cx, |view, cx| view.request_quit(cx));
        assert!(
            view.read(cx).closing,
            "Quit is safe before any workspace opens"
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn unsupported_provider_shows_recovery_and_only_real_children_at_narrow_width(
    cx: &mut TestAppContext,
) {
    let (handle, view) = fixture(cx, 760.);
    cx.update_window(handle,|_,window,cx| {
        view.update(cx,|view,cx| {
            let state=&mut view.workspaces[0].state;
            state.request=None;state.model_available=false;state.model_error=Some("unsupported provider: home".into());
            state.tasks=vec![json!({"kind":"shell","task_id":"shell","title":"ls -la"}),json!({"kind":"subagent","task_id":"child","name":"Research","state":"completed","subagent":{"owner_session_id":"owner"}})];
            view.composer.update(cx,|input,cx|input.set_value("未送信の依頼",window,cx));
        });
        window.render_frame(cx);
        for index in 0usize..6 {
            let bounds=window.find(("model-provider",index)).bounds();
            assert!(bounds.origin.x>=px(220.) && bounds.right()<=px(760.) && bounds.origin.y>=px(0.) && bounds.bottom()<=px(560.),"provider {index} is reachable: {bounds:?}");
        }
        assert!(window.find(("child-agent",0usize)).visible());
        assert!(window.try_find(("child-agent",1usize)).is_none(),"shell commands do not appear as children");
        window.click("send",cx);
        view.update(cx,|view,cx|view.send_prompt(window,cx));
        assert!(!view.read(cx).workspaces[0].state.busy);assert!(view.read(cx).workspaces[0].state.connected);
        assert_eq!(view.read(cx).composer.read(cx).value(),"未送信の依頼");
        view.update(cx,|view,_| {
            let s=&mut view.workspaces[0].state;let list=s.rpc("model.list",json!({"provider":"openai","catalog_only":true}));
            s.handle(json!({"id":list["id"],"result":{"provider":"openai","catalog_only":true,"models":["gpt-6.1-sol"]}}));
        });
        window.render_frame(cx);window.click(("model-option",0usize),cx);
        assert!(view.read(cx).workspaces[0].state.model_ready());
        assert_eq!(view.read(cx).composer.read(cx).value(),"未送信の依頼");
        assert!(!view.read(cx).workspaces[0].state.has_pending("model.set"));
    }).unwrap();
}
