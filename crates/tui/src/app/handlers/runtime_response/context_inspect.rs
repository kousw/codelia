use super::formatters::push_rpc_error;
use super::panel_builders::format_context_file_row;
use crate::app::runtime::RpcResponse;
use crate::app::{AppState, ContextPanelState, LocalPanel};
use crate::protocol::{decode_result, methods, ContextInspectFile, ContextInspectResult};

pub(super) fn handle_context_inspect_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "context.inspect", &error);
        return;
    }
    if let Some(result) = response.result {
        match decode_result::<methods::ContextInspect>(result) {
            Ok(result) => apply_context_inspect_result(app, &result),
            Err(error) => super::push_protocol_mismatch(app, &error),
        }
    }
}

fn push_files(rows: &mut Vec<String>, label: &str, files: &[ContextInspectFile]) {
    if files.is_empty() {
        rows.push(format!("{label}: (none)"));
        return;
    }
    rows.push(format!("{label}:"));
    for file in files {
        rows.push(format!("  {}", format_context_file_row(file)));
    }
}

fn apply_context_inspect_result(app: &mut AppState, result: &ContextInspectResult) {
    let mut rows = Vec::new();

    if let Some(percent) = app.context_left_percent {
        rows.push(format!("context_left_percent: {percent}%"));
    }
    if let Some(runtime_working_dir) = &result.runtime_working_dir {
        rows.push(format!("runtime_working_dir: {runtime_working_dir}"));
    }
    if let Some(runtime_sandbox_root) = &result.runtime_sandbox_root {
        rows.push(format!("runtime_sandbox_root: {runtime_sandbox_root}"));
    }
    if let Some(execution_environment) = &result.execution_environment {
        rows.push(String::new());
        rows.push("EXECUTION ENVIRONMENT".to_string());
        for line in execution_environment.lines() {
            rows.push(line.to_string());
        }
    }
    if let Some(ui_context) = &result.ui_context {
        if let Some(cwd) = &ui_context.cwd {
            rows.push(format!("ui.cwd: {cwd}"));
        }
        if let Some(workspace_root) = &ui_context.workspace_root {
            rows.push(format!("ui.workspace_root: {workspace_root}"));
        }
        if let Some(active_file_path) = &ui_context.active_file_path {
            rows.push(format!("ui.active_file: {active_file_path}"));
        }
    }

    rows.push(String::new());
    rows.push("AGENTS".to_string());
    if let Some(agents) = &result.agents {
        rows.push(format!("enabled: {}", agents.enabled));
        rows.push(format!("root_dir: {}", agents.root_dir));
        rows.push(format!("working_dir: {}", agents.working_dir));
        push_files(&mut rows, "initial_files", &agents.initial_files);
        push_files(&mut rows, "loaded_files", &agents.loaded_files);
    } else {
        rows.push("unavailable".to_string());
    }

    rows.push(String::new());
    rows.push("SKILLS".to_string());
    if let Some(skills) = &result.skills {
        rows.push(format!("root_dir: {}", skills.root_dir));
        rows.push(format!("working_dir: {}", skills.working_dir));
        let catalog = &skills.catalog;
        rows.push(format!(
            "catalog: skills={}, errors={}, truncated={}",
            catalog.skills.len(),
            catalog.errors.len(),
            catalog.truncated
        ));
        if catalog.skills.is_empty() {
            rows.push("skills: (none)".to_string());
        } else {
            rows.push("skills:".to_string());
            for item in &catalog.skills {
                rows.push(format!(
                    "  - [{}] {} ({})",
                    item.scope.as_str(),
                    item.name,
                    item.path
                ));
            }
        }
        if skills.loaded_versions.is_empty() {
            rows.push("loaded_versions: (none)".to_string());
        } else {
            rows.push("loaded_versions:".to_string());
            for entry in &skills.loaded_versions {
                rows.push(format!("  - {} (mtime={})", entry.path, entry.mtime_ms));
            }
        }
    } else {
        rows.push("unavailable".to_string());
    }
    app.overlays.local_panel = Some(LocalPanel::Context(ContextPanelState {
        title: "Context".to_string(),
        header: "snapshot".to_string(),
        rows,
        selected: 0,
    }));
}
