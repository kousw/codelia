mod bang;
mod prompt;
mod queue;
mod slash;

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
use slash::{
    handle_compact_command, handle_context_command, handle_errors_command, handle_help_command,
    handle_lane_command, handle_logout_command, handle_mcp_command, handle_model_command,
    handle_skills_command, handle_tasks_command, handle_theme_command,
};

const MODEL_PROVIDERS: &[&str] = &["openai", "anthropic", "openrouter"];
const COMMAND_SUGGESTION_LIMIT: usize = 12;
const QUEUE_PREVIEW_MAX_CHARS: usize = 72;
const QUEUE_LIST_LIMIT: usize = 5;
const QUEUE_EMPTY_MESSAGE: &str = "queue is empty";
const QUEUE_USAGE_MESSAGE: &str = "usage: /queue [cancel [id|index]|clear]";
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
    let raw_input = app.input.current().to_string();
    let trimmed = raw_input.trim().to_string();
    if trimmed.is_empty() {
        app.input.clear();
        return true;
    }

    let mut parts = trimmed.split_whitespace();
    let command = parts.next().unwrap_or_default();
    let mut clear_input = true;
    if app.bang_input_mode {
        clear_input = handle_bang_command(app, child_stdin, next_id, &raw_input);
    } else if command == "/compact" {
        handle_compact_command(app, child_stdin, next_id, &trimmed, &mut parts);
    } else if command == "/model" {
        handle_model_command(app, child_stdin, next_id, &mut parts);
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
        handle_queue_command(app, &mut parts);
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

#[cfg(test)]
mod tests {
    use super::bang::resolve_bang_command;
    use super::{
        build_shell_result_prefix, handle_enter, try_dispatch_queued_prompt, QUEUE_EMPTY_MESSAGE,
    };
    use crate::app::util::attachments::make_attachment_token;
    use crate::app::{AppState, PendingShellResult};
    use std::io::{BufWriter, Write};
    use std::process::Stdio;

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
}
