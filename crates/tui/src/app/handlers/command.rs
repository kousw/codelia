mod bang;
mod image;
mod prompt;
mod queue;
mod session;
mod slash;
pub(crate) mod upload;

use crate::app::state::{
    complete_skill_mention as complete_skill_mention_input,
    complete_slash_command as complete_slash_command_input, is_known_command,
    unknown_command_message, InputState, LogKind,
};
use crate::app::{AppState, SkillsListItemState};
use std::io::BufWriter;
use std::process::ChildStdin;

use bang::{build_shell_result_prefix, handle_bang_command};
use queue::handle_queue_command;
pub(crate) use queue::{handle_queue_steer_picker_key, open_queue_steer_picker};
use slash::{
    handle_compact_command, handle_context_command, handle_errors_command, handle_fast_command,
    handle_help_command, handle_lane_command, handle_logout_command, handle_mcp_command,
    handle_model_command, handle_model_session_command, handle_skills_command,
    handle_tasks_command, handle_theme_command,
};

const MODEL_PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "openrouter",
    "deepseek",
    "moonshot",
    "zai",
    "xai",
];
const COMMAND_SUGGESTION_LIMIT: usize = 12;
const QUEUE_PREVIEW_MAX_CHARS: usize = 72;
const QUEUE_LIST_LIMIT: usize = 5;
const QUEUE_EMPTY_MESSAGE: &str = "queue is empty";
const QUEUE_USAGE_MESSAGE: &str =
    "usage: /queue [pick|mode [queue|steer|toggle]|steer [id|index]|retry|cancel [id|index]|clear]";
const QUEUE_MODE_USAGE_MESSAGE: &str = "usage: /queue mode [queue|steer|toggle]";
const QUEUE_STEER_USAGE_MESSAGE: &str = "usage: /queue steer [id|index]";
const QUEUE_CANCEL_USAGE_MESSAGE: &str = "usage: /queue cancel [id|index]";
const QUEUE_CLEAR_USAGE_MESSAGE: &str = "usage: /queue clear";
const TASKS_USAGE_MESSAGE: &str = "usage: /tasks [list|show <task_id>|cancel <task_id>]";

type RuntimeStdin = BufWriter<ChildStdin>;

pub(crate) fn complete_slash_command(input: &mut InputState) -> bool {
    complete_slash_command_input(input)
}

pub(crate) fn complete_skill_mention(
    input: &mut InputState,
    skills: &[SkillsListItemState],
) -> bool {
    complete_skill_mention_input(input, skills)
}

pub(crate) fn handle_enter(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    if app.has_pending_clipboard_import() {
        app.push_line(
            LogKind::Status,
            "Wait for the pasted files to finish loading.",
        );
        return true;
    }
    let raw_input = app.input.current().to_string();
    let trimmed = raw_input.trim().to_string();
    if trimmed.is_empty() {
        app.input.clear();
        return true;
    }

    let mut parts = trimmed.split_whitespace();
    let command = parts.next().unwrap_or_default();
    if app.referenced_attachment_count() > 0
        && (app.bang_input_mode
            || trimmed.starts_with('!')
            || (command.starts_with('/') && command != "/steer"))
    {
        app.push_line(
            LogKind::Error,
            "Send attachments with a prompt or /steer. Remove them to run this command.",
        );
        return true;
    }
    let mut clear_input = true;
    if app.bang_input_mode {
        clear_input = handle_bang_command(app, child_stdin, next_id, &raw_input);
    } else if command == "/image" {
        super::image_preview::handle_command(app, trimmed["/image".len()..].trim());
    } else if command == "/image-model" {
        image::handle(
            app,
            child_stdin,
            next_id,
            trimmed["/image-model".len()..].trim(),
            false,
        );
    } else if command == "/image-artifact" {
        image::handle(
            app,
            child_stdin,
            next_id,
            trimmed["/image-artifact".len()..].trim(),
            true,
        );
    } else if command == "/session" {
        session::handle(
            app,
            child_stdin,
            next_id,
            trimmed["/session".len()..].trim(),
        );
    } else if command == "/compact" {
        handle_compact_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/model" {
        handle_model_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/model-session" {
        handle_model_session_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/fast" {
        handle_fast_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/context" {
        handle_context_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/skills" {
        handle_skills_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/theme" {
        handle_theme_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/mcp" {
        handle_mcp_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/logout" {
        handle_logout_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/lane" {
        handle_lane_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/errors" {
        handle_errors_command(app, &mut parts);
    } else if command == "/queue" {
        handle_queue_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/steer" {
        let steer_arg = trimmed
            .strip_prefix("/steer")
            .map(str::trim_start)
            .unwrap_or("");
        clear_input = prompt::start_explicit_steer_run(app, child_stdin, next_id, steer_arg);
    } else if command == "/tasks" {
        handle_tasks_command(app, child_stdin, next_id, &mut parts);
    } else if command == "/help" {
        handle_help_command(app, &mut parts);
    } else if trimmed.starts_with("!") {
        clear_input = handle_bang_command(app, child_stdin, next_id, &raw_input);
    } else if !is_known_command(command) && command.starts_with('/') {
        app.push_line(LogKind::Error, unknown_command_message(command));
        clear_input = false;
    } else {
        clear_input = start_prompt_run(app, child_stdin, next_id, &raw_input);
    }

    if clear_input {
        app.clear_composer();
    }
    true
}

pub(crate) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    prompt::can_dispatch_prompt_now(app)
}

pub(crate) fn try_dispatch_queued_prompt(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    prompt::try_dispatch_queued_prompt(app, child_stdin, next_id)
}

pub(crate) fn start_prompt_run(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
    raw_input: &str,
) -> bool {
    prompt::start_prompt_run(app, child_stdin, next_id, raw_input)
}

pub(crate) fn insert_pending_prompt_ordered(
    queue: &mut std::collections::VecDeque<crate::app::PendingPromptRun>,
    item: crate::app::PendingPromptRun,
) {
    prompt::insert_pending_prompt_ordered(queue, item);
}

#[cfg(test)]
mod tests {
    use super::bang::resolve_bang_command;
    use super::{
        build_shell_result_prefix, can_dispatch_prompt_now, handle_enter,
        try_dispatch_queued_prompt, MODEL_PROVIDERS, QUEUE_EMPTY_MESSAGE,
    };
    use crate::app::handlers::runtime_response::handle_run_start_response;
    use crate::app::runtime::RpcResponse;
    use crate::app::util::attachments::make_attachment_token;
    use crate::app::{
        AppState, PendingPromptRun, PendingShellResult, PROMPT_DISPATCH_MAX_ATTEMPTS,
    };
    use serde_json::json;
    use std::io::{BufWriter, Write};
    use std::process::Stdio;
    use std::time::Instant;

    fn queued_prompt(id: &str, attempts: u32, payload: serde_json::Value) -> PendingPromptRun {
        PendingPromptRun {
            seq: 0,
            queue_id: id.to_string(),
            queued_at: Instant::now(),
            preview: "queued input".to_string(),
            user_text: "queued input".to_string(),
            display_text: "queued input".to_string(),
            image_descriptions: Vec::new(),
            input_payload: payload,
            attachment_count: 1,
            files: Default::default(),
            shell_result_count: 0,
            dispatch_attempts: attempts,
        }
    }

    fn with_runtime_writer<T>(f: impl FnOnce(&mut BufWriter<std::process::ChildStdin>) -> T) -> T {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "more"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("cat");

        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn runtime writer helper");

        let child_stdin = child.stdin.take().expect("child stdin");
        let mut runtime_writer = BufWriter::new(child_stdin);
        let out = f(&mut runtime_writer);

        let _ = runtime_writer.flush();
        let _ = child.kill();
        let _ = child.wait();
        out
    }

    #[test]
    fn model_provider_picker_includes_xai() {
        assert!(MODEL_PROVIDERS.contains(&"xai"));
    }

    #[test]
    #[cfg(unix)]
    fn session_command_is_capability_gated_and_preserves_explicit_false() {
        let mut child = std::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("capture session requests");
        let mut writer = BufWriter::new(child.stdin.take().expect("stdin"));
        let mut app = AppState::default();
        app.runtime_info.session_id = Some("current-session".to_string());
        let mut next_id = || "session-update".to_string();
        app.input.set_from("/session pin");
        handle_enter(&mut app, &mut writer, &mut next_id);
        assert!(app.rpc_pending.session_update_id.is_none());
        app.runtime_info.supports_session_lifecycle = true;
        app.input.set_from("/session unpin");
        handle_enter(&mut app, &mut writer, &mut next_id);
        assert_eq!(
            app.rpc_pending.session_update_id.as_deref(),
            Some("session-update")
        );
        drop(writer);
        let output = child.wait_with_output().expect("session request output");
        let request: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("one request");
        assert_eq!(request["method"], "session.update");
        assert_eq!(request["params"]["session_id"], "current-session");
        assert_eq!(request["params"]["pinned"], false);
        assert!(request["params"].get("archived").is_none());
    }

    #[test]
    #[cfg(unix)]
    fn fast_command_preserves_boolean_wire_values_and_requires_ultrafast_capability() {
        let mut child = std::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("capture fast requests");
        let mut writer = BufWriter::new(child.stdin.take().expect("stdin"));
        let mut app = AppState::default();
        app.runtime_info.current_provider = Some("openai".to_string());
        app.runtime_info.current_model = Some("gpt-6.1-sol".to_string());
        let mut next_id = || "fast-test".to_string();
        app.input.set_from("/fast ultrafast");
        assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        assert!(app.rpc_pending.model_set_id.is_none());
        app.runtime_info.supports_model_ultrafast = true;
        app.input.set_from("/fast ultrafast");
        assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        app.runtime_info.current_fast = Some(crate::app::ModelFastMode::Ultrafast);
        app.input.set_from("/fast");
        assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        app.input.set_from("/fast on");
        assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        drop(writer);
        let output = child.wait_with_output().expect("fast output");
        let requests: Vec<serde_json::Value> = String::from_utf8(output.stdout)
            .expect("utf8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("json"))
            .collect();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0]["params"]["fast"], "ultrafast");
        assert_eq!(requests[1]["params"]["fast"], false);
        assert_eq!(requests[2]["params"]["fast"], true);
    }

    #[test]
    #[cfg(unix)]
    fn logout_command_transmits_only_the_requested_provider_and_rejects_extra_arguments() {
        let mut child = std::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("capture logout requests");
        let mut writer = BufWriter::new(child.stdin.take().expect("stdin"));
        let mut app = AppState::default();
        let mut seq = 0;
        let mut next_id = || {
            seq += 1;
            format!("logout-{seq}")
        };
        // An older runtime must receive no named logout request.
        app.input.set_from("/logout home");
        assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        assert!(app.rpc_pending.logout_id.is_none());
        app.runtime_info.supports_scoped_logout = true;
        for command in ["/logout home", "/logout", "/logout home openai"] {
            app.input.set_from(command);
            assert!(handle_enter(&mut app, &mut writer, &mut next_id));
        }
        drop(writer);
        let output = child.wait_with_output().expect("logout output");
        let requests: Vec<serde_json::Value> = String::from_utf8(output.stdout)
            .expect("utf8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("json"))
            .collect();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["method"], "auth.logout");
        assert_eq!(
            requests[0]["params"],
            serde_json::json!({"provider":"home", "clear_session":true})
        );
        assert_eq!(
            requests[1]["params"],
            serde_json::json!({"clear_session":true})
        );
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("usage: /logout [provider]")));
    }

    #[test]
    fn shell_result_prefix_escapes_angle_brackets() {
        let result = PendingShellResult {
            id: "shell_1".to_string(),
            command_preview: "echo <tag>".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 10,
            stdout: Some("ok".to_string()),
            stderr: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_cache_id: None,
            stderr_cache_id: None,
            truncated_stdout: false,
            truncated_stderr: false,
            truncated_combined: false,
        };
        let prefix = build_shell_result_prefix(&[result]).expect("prefix");
        assert!(prefix.contains("<shell_result>"));
        assert!(prefix.contains("\\u003ctag\\u003e"));
    }

    #[test]
    fn resolve_bang_command_strips_single_prefix_outside_mode() {
        assert_eq!(resolve_bang_command("!git status", false), "git status");
        assert_eq!(resolve_bang_command("!!echo", false), "!echo");
    }

    #[test]
    fn resolve_bang_command_uses_raw_text_in_bang_mode() {
        assert_eq!(resolve_bang_command("echo hi", true), "echo hi");
        assert_eq!(resolve_bang_command("!echo hi", true), "!echo hi");
    }

    #[test]
    fn bang_command_uses_shell_start_when_shell_tasks_are_available() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_shell_exec = true;
            app.runtime_info.supports_shell_tasks = true;
            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("!echo hi");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.rpc_pending.shell_start_id.as_deref(), Some("id-1"));
            assert!(app.rpc_pending.shell_exec_id.is_none());
        });
    }

    #[test]
    fn tasks_command_starts_task_list_request() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_tasks = true;
            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("/tasks");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.rpc_pending.task_list_id.as_deref(), Some("id-1"));
        });
    }

    #[test]
    fn enqueue_while_run_active_snapshots_payload_and_clears_shell_results_once() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_shell_exec = true;
            app.update_run_status("running".to_string());
            app.pending_shell_results.push(PendingShellResult {
                id: "shell_1".to_string(),
                command_preview: "echo hi".to_string(),
                exit_code: Some(0),
                signal: None,
                duration_ms: 1,
                stdout: Some("hi".to_string()),
                stderr: None,
                stdout_excerpt: None,
                stderr_excerpt: None,
                stdout_cache_id: None,
                stderr_cache_id: None,
                truncated_stdout: false,
                truncated_stderr: false,
                truncated_combined: false,
            });

            let attachment_id = app.next_image_attachment_id();
            app.add_pending_image_attachment(
                attachment_id.clone(),
                crate::app::PendingImageAttachment {
                    data_url: "data:image/png;base64,AAAA".to_string(),
                    width: 10,
                    height: 10,
                    encoded_bytes: 1024,
                },
            );
            let token = make_attachment_token(&app.composer_nonce, &attachment_id);
            app.input.set_from(&format!("hello {token}"));

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert!(app.pending_shell_results.is_empty());
            assert!(app.input.current().is_empty());
            assert!(app.pending_image_attachments.is_empty());

            let queued = app.pending_prompt_queue.front().expect("queued");
            assert_eq!(queued.shell_result_count, 1);
            assert_eq!(queued.attachment_count, 1);
            assert_eq!(queued.queue_id, "q1");
            let parts = queued
                .input_payload
                .get("parts")
                .and_then(|value| value.as_array())
                .expect("parts payload");
            assert!(parts
                .iter()
                .any(|part| part.get("type").and_then(|v| v.as_str()) == Some("image_url")));

            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 0);
            assert!(app.dispatching_prompt.is_some());
            assert!(app.rpc_pending.run_start_id.is_some());
        });
    }

    #[test]
    fn queue_commands_cancel_and_clear() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("first");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("second");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("third");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 3);

            app.input.set_from("/queue cancel q2");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 2);
            assert_eq!(
                app.pending_prompt_queue
                    .iter()
                    .map(|item| item.queue_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["q1", "q3"]
            );

            app.input.set_from("/queue cancel");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert_eq!(
                app.pending_prompt_queue
                    .front()
                    .map(|item| item.queue_id.as_str()),
                Some("q3")
            );

            app.input.set_from("/queue clear");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.pending_prompt_queue.is_empty());

            app.input.set_from("/queue");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains(QUEUE_EMPTY_MESSAGE)));
        });
    }

    #[test]
    fn failed_queue_item_keeps_image_payload_until_explicit_retry() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let payload = json!({"type": "parts", "parts": [
                {"type": "text", "text": "keep this"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
            ]});
            app.dispatching_prompt = Some(queued_prompt(
                "q1",
                PROMPT_DISPATCH_MAX_ATTEMPTS - 1,
                payload.clone(),
            ));
            app.pending_prompt_queue.push_back(queued_prompt(
                "q2",
                0,
                json!({"type": "text", "text": "next"}),
            ));
            handle_run_start_response(
                &mut app,
                RpcResponse {
                    id: "request".to_string(),
                    result: None,
                    error: Some(json!({"code": -32001, "message": "runtime busy"})),
                },
            );
            assert_eq!(app.pending_prompt_queue.len(), 2);
            assert_eq!(app.pending_prompt_queue[0].input_payload, payload);
            assert!(!can_dispatch_prompt_now(&app));
            let mut next_id = || "retry-request".to_string();
            assert!(!try_dispatch_queued_prompt(&mut app, writer, &mut next_id));

            app.input.set_from("/queue retry");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(
                app.dispatching_prompt.as_ref().unwrap().input_payload,
                payload
            );
            assert_eq!(app.pending_prompt_queue[0].queue_id, "q2");
        });
    }

    #[test]
    fn cancelling_paused_queue_head_allows_next_prompt_to_dispatch() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.pending_prompt_queue.push_back(queued_prompt(
                "q1",
                PROMPT_DISPATCH_MAX_ATTEMPTS,
                json!({"type": "text", "text": "failed"}),
            ));
            app.pending_prompt_queue.push_back(queued_prompt(
                "q2",
                0,
                json!({"type": "text", "text": "next"}),
            ));
            let mut next_id = || "next-request".to_string();
            app.input.set_from("/queue cancel");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(app.dispatching_prompt.as_ref().unwrap().queue_id, "q2");
        });
    }

    #[test]
    fn unknown_run_start_outcome_pauses_without_automatic_retry() {
        with_runtime_writer(|writer| {
            for response in [
                RpcResponse {
                    id: "error".to_string(),
                    result: None,
                    error: Some(json!({"code": -32000, "message": "internal runtime error"})),
                },
                RpcResponse {
                    id: "missing-result".to_string(),
                    result: None,
                    error: None,
                },
            ] {
                let mut app = AppState::default();
                app.dispatching_prompt = Some(queued_prompt(
                    "q1",
                    0,
                    json!({"type": "text", "text": "keep this"}),
                ));
                handle_run_start_response(&mut app, response);
                assert_eq!(app.pending_prompt_queue.len(), 1);
                assert!(!can_dispatch_prompt_now(&app));
                let mut next_id = || "not-sent".to_string();
                assert!(!try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            }
        });
    }

    #[test]
    #[cfg(unix)]
    fn disconnected_runtime_keeps_the_unsent_prompt_paused() {
        // A pipe to an exited child is not a reliable fixture: a sibling test can fork
        // while the read end is still open, so the write may succeed. Shutting down
        // the write side of a socket makes every write fail with EPIPE regardless of
        // how many processes hold the descriptor.
        let (runtime_end, _peer) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        runtime_end
            .shutdown(std::net::Shutdown::Write)
            .expect("shut down write side");
        let stdin = std::process::ChildStdin::from(std::os::fd::OwnedFd::from(runtime_end));
        let mut writer = BufWriter::new(stdin);
        let mut app = AppState::default();
        let payload = json!({"type": "text", "text": "keep this"});
        app.pending_prompt_queue
            .push_back(queued_prompt("q1", 0, payload.clone()));
        let mut next_id = || "request".to_string();
        assert!(try_dispatch_queued_prompt(
            &mut app,
            &mut writer,
            &mut next_id
        ));
        assert_eq!(app.pending_prompt_queue[0].input_payload, payload);
        assert!(!can_dispatch_prompt_now(&app));
        assert!(app
            .log
            .iter()
            .any(|line| line.plain_text().contains("send outcome is unknown")));
    }

    #[test]
    fn run_start_response_keeps_shell_results_created_after_submission() {
        let mut app = AppState::default();
        app.dispatching_prompt = Some(queued_prompt(
            "q1",
            0,
            json!({"type": "text", "text": "queued"}),
        ));
        app.pending_shell_results.push(PendingShellResult {
            id: "later-shell".to_string(),
            command_preview: "echo later".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 1,
            stdout: Some("later".to_string()),
            stderr: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_cache_id: None,
            stderr_cache_id: None,
            truncated_stdout: false,
            truncated_stderr: false,
            truncated_combined: false,
        });
        handle_run_start_response(
            &mut app,
            RpcResponse {
                id: "start".to_string(),
                result: Some(json!({"run_id": "run-1"})),
                error: None,
            },
        );
        assert_eq!(app.pending_shell_results.len(), 1);
        assert_eq!(app.pending_shell_results[0].id, "later-shell");
    }

    #[test]
    fn queued_dispatch_is_fifo() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("first");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            app.input.set_from("second");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 2);

            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(
                app.dispatching_prompt
                    .as_ref()
                    .map(|item| item.queue_id.as_str()),
                Some("q1")
            );
            assert_eq!(
                app.pending_prompt_queue
                    .front()
                    .map(|item| item.queue_id.as_str()),
                Some("q2")
            );

            app.dispatching_prompt = None;
            app.rpc_pending.run_start_id = None;
            app.update_run_status("completed".to_string());
            assert!(try_dispatch_queued_prompt(&mut app, writer, &mut next_id));
            assert_eq!(
                app.dispatching_prompt
                    .as_ref()
                    .map(|item| item.queue_id.as_str()),
                Some("q2")
            );
        });
    }

    #[test]
    fn idle_submit_still_dispatches_immediately_via_queue_path() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("hello");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.pending_prompt_queue.is_empty());
            assert!(app.dispatching_prompt.is_some());
            assert!(app.rpc_pending.run_start_id.is_some());
        });
    }

    #[test]
    fn steer_command_requires_runtime_support_and_dispatches_in_flight_steer() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.update_run_status("running".to_string());
            app.runtime_info.active_run_id = Some("run-1".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("/steer focus tests");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.in_flight_steers.is_empty());
            assert!(app.pending_prompt_queue.is_empty());
            assert!(app
                .log
                .iter()
                .any(|line| line.plain_text().contains("does not support run.steer")));

            app.runtime_info.supports_run_steer = true;
            app.input.set_from("/steer focus tests");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.in_flight_steers.len(), 1);
            assert_eq!(app.in_flight_steers[0].run_id, "run-1");
            assert_eq!(app.in_flight_steers[0].submission.user_text, "focus tests");
            assert_eq!(app.rpc_pending.run_steer_ids.len(), 1);
        });
    }

    #[test]
    fn queue_picker_promotes_selected_id_and_keeps_the_draft() {
        use crate::event_loop::input::{handle_non_main_key, handle_paste};
        use crossterm::event::{KeyCode, KeyModifiers};
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_run_steer = true;
            app.update_run_status("running".into());
            app.runtime_info.active_run_id = Some("run-1".into());
            let mut next_id = || "rpc".to_string();
            for text in ["first", "paused", "second", "/queue pick"] {
                app.input.set_from(text);
                handle_enter(&mut app, writer, &mut next_id);
            }
            app.pending_prompt_queue[1].dispatch_attempts =
                crate::app::PROMPT_DISPATCH_MAX_ATTEMPTS;
            app.input.set_from("unfinished draft");
            assert!(!handle_paste(&mut app, "paste"));
            assert_eq!(
                handle_non_main_key(
                    &mut app,
                    KeyCode::Enter,
                    KeyModifiers::SHIFT,
                    writer,
                    &mut next_id
                ),
                Some(false)
            );
            assert!(app.in_flight_steers.is_empty());
            assert!(app.queue_steer_picker.is_some());
            let mut press = |app: &mut AppState, key| {
                assert_eq!(
                    handle_non_main_key(app, key, KeyModifiers::NONE, writer, &mut next_id),
                    Some(true)
                );
            };
            press(&mut app, KeyCode::Down);
            press(&mut app, KeyCode::Up);
            press(&mut app, KeyCode::Down);
            app.pending_prompt_queue.pop_front();
            press(&mut app, KeyCode::Enter);
            assert!(app.queue_steer_picker.is_none());
            assert_eq!(app.input.current(), "unfinished draft");
            assert_eq!(app.in_flight_steers[0].submission.user_text, "second");
            assert_eq!(app.pending_prompt_queue[0].user_text, "paused");
        });
    }

    #[test]
    fn queue_picker_cancel_and_run_replacement_do_not_dispatch() {
        use super::{handle_queue_steer_picker_key, open_queue_steer_picker};
        use crossterm::event::KeyCode;
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_run_steer = true;
            app.update_run_status("running".into());
            app.runtime_info.active_run_id = Some("run-1".into());
            let mut next_id = || "rpc".to_string();
            app.input.set_from("queued");
            handle_enter(&mut app, writer, &mut next_id);
            app.input.set_from("draft");
            open_queue_steer_picker(&mut app);
            assert_eq!(
                handle_queue_steer_picker_key(&mut app, KeyCode::Esc, writer, &mut next_id),
                Some(true)
            );
            open_queue_steer_picker(&mut app);
            app.runtime_info.active_run_id = Some("run-2".into());
            assert_eq!(
                handle_queue_steer_picker_key(&mut app, KeyCode::Enter, writer, &mut next_id),
                Some(true)
            );
            assert!(app.queue_steer_picker.is_none());
            assert_eq!(app.input.current(), "draft");
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert!(app.in_flight_steers.is_empty());
        });
    }

    #[test]
    fn active_run_steer_mode_routes_enter_and_queue_steer_promotes_queued_item() {
        with_runtime_writer(|writer| {
            let mut app = AppState::default();
            app.runtime_info.supports_run_steer = true;
            app.update_run_status("running".to_string());
            app.runtime_info.active_run_id = Some("run-1".to_string());

            let mut seq = 0_u64;
            let mut next_id = || {
                seq += 1;
                format!("id-{seq}")
            };

            app.input.set_from("queued first");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.pending_prompt_queue.len(), 1);
            assert!(app.in_flight_steers.is_empty());

            app.input.set_from("/queue mode steer");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(
                app.active_run_submit_mode,
                crate::app::ActiveRunSubmitMode::Steer
            );

            app.input.set_from("direct steer");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert_eq!(app.in_flight_steers.len(), 1);
            assert_eq!(app.in_flight_steers[0].submission.user_text, "direct steer");

            app.input.set_from("/queue steer 1");
            assert!(handle_enter(&mut app, writer, &mut next_id));
            assert!(app.pending_prompt_queue.is_empty());
            assert_eq!(app.in_flight_steers.len(), 2);
            assert_eq!(app.in_flight_steers[1].submission.user_text, "queued first");
        });
    }
}
