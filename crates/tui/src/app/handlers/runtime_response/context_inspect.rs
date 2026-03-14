use super::formatters::push_rpc_error;
use super::panel_builders::format_context_file_row;
use crate::app::runtime::RpcResponse;
use crate::app::{AppState, ContextPanelState};
use serde_json::Value;

pub(super) fn handle_context_inspect_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "context.inspect", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_context_inspect_result(app, &result);
    }
}

fn apply_context_inspect_result(app: &mut AppState, result: &Value) {
    let mut rows = Vec::new();

    if let Some(percent) = app.context_left_percent {
        rows.push(format!("context_left_percent: {percent}%"));
    }
    if let Some(runtime_working_dir) = result
        .get("runtime_working_dir")
        .and_then(|value| value.as_str())
    {
        rows.push(format!("runtime_working_dir: {runtime_working_dir}"));
    }
    if let Some(runtime_sandbox_root) = result
        .get("runtime_sandbox_root")
        .and_then(|value| value.as_str())
    {
        rows.push(format!("runtime_sandbox_root: {runtime_sandbox_root}"));
    }
    if let Some(execution_environment) = result
        .get("execution_environment")
        .and_then(|value| value.as_str())
    {
        rows.push(String::new());
        rows.push("EXECUTION ENVIRONMENT".to_string());
        for line in execution_environment.lines() {
            rows.push(line.to_string());
        }
    }
    if let Some(ui_context) = result.get("ui_context").and_then(|value| value.as_object()) {
        if let Some(cwd) = ui_context.get("cwd").and_then(|value| value.as_str()) {
            rows.push(format!("ui.cwd: {cwd}"));
        }
        if let Some(workspace_root) = ui_context
            .get("workspace_root")
            .and_then(|value| value.as_str())
        {
            rows.push(format!("ui.workspace_root: {workspace_root}"));
        }
        if let Some(active_file_path) = ui_context
            .get("active_file_path")
            .and_then(|value| value.as_str())
        {
            rows.push(format!("ui.active_file: {active_file_path}"));
        }
    }

    rows.push(String::new());
    rows.push("AGENTS".to_string());

    if let Some(agents) = result.get("agents").and_then(|value| value.as_object()) {
        let enabled = agents
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let root_dir = agents
            .get("root_dir")
            .and_then(|value| value.as_str())
            .unwrap_or("-");
        rows.push(format!("enabled: {enabled}"));
        rows.push(format!("root_dir: {root_dir}"));
        if let Some(working_dir) = agents.get("working_dir").and_then(|value| value.as_str()) {
            rows.push(format!("working_dir: {working_dir}"));
        }

        if let Some(initial_files) = agents
            .get("initial_files")
            .and_then(|value| value.as_array())
        {
            if initial_files.is_empty() {
                rows.push("initial_files: (none)".to_string());
            } else {
                rows.push("initial_files:".to_string());
                for file in initial_files {
                    if let Some(line) = format_context_file_row(file) {
                        rows.push(format!("  {line}"));
                    }
                }
            }
        }
        if let Some(loaded_files) = agents
            .get("loaded_files")
            .and_then(|value| value.as_array())
        {
            if loaded_files.is_empty() {
                rows.push("loaded_files: (none)".to_string());
            } else {
                rows.push("loaded_files:".to_string());
                for file in loaded_files {
                    if let Some(line) = format_context_file_row(file) {
                        rows.push(format!("  {line}"));
                    }
                }
            }
        }
    } else {
        rows.push("unavailable".to_string());
    }

    rows.push(String::new());
    rows.push("SKILLS".to_string());
    if let Some(skills) = result.get("skills").and_then(|value| value.as_object()) {
        if let Some(root_dir) = skills.get("root_dir").and_then(|value| value.as_str()) {
            rows.push(format!("root_dir: {root_dir}"));
        }
        if let Some(working_dir) = skills.get("working_dir").and_then(|value| value.as_str()) {
            rows.push(format!("working_dir: {working_dir}"));
        }
        if let Some(catalog) = skills.get("catalog").and_then(|value| value.as_object()) {
            let skills_count = catalog
                .get("skills")
                .and_then(|value| value.as_array())
                .map(|value| value.len())
                .unwrap_or(0);
            let errors_count = catalog
                .get("errors")
                .and_then(|value| value.as_array())
                .map(|value| value.len())
                .unwrap_or(0);
            let truncated = catalog
                .get("truncated")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            rows.push(format!(
                "catalog: skills={skills_count}, errors={errors_count}, truncated={truncated}"
            ));
            if let Some(skill_items) = catalog.get("skills").and_then(|value| value.as_array()) {
                if skill_items.is_empty() {
                    rows.push("skills: (none)".to_string());
                } else {
                    rows.push("skills:".to_string());
                    for item in skill_items {
                        let name = item
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        let scope = item
                            .get("scope")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        let path = item
                            .get("path")
                            .and_then(|value| value.as_str())
                            .unwrap_or("-");
                        rows.push(format!("  - [{scope}] {name} ({path})"));
                    }
                }
            }
        }
        if let Some(loaded_versions) = skills
            .get("loaded_versions")
            .and_then(|value| value.as_array())
        {
            if loaded_versions.is_empty() {
                rows.push("loaded_versions: (none)".to_string());
            } else {
                rows.push("loaded_versions:".to_string());
                for entry in loaded_versions {
                    let path = entry
                        .get("path")
                        .and_then(|value| value.as_str())
                        .unwrap_or("-");
                    let mtime = entry
                        .get("mtime_ms")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0);
                    rows.push(format!("  - {path} (mtime={mtime})"));
                }
            }
        }
    } else {
        rows.push("unavailable".to_string());
    }
    app.model_list_panel = None;
    app.reasoning_picker = None;
    app.session_list_panel = None;
    app.lane_list_panel = None;
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    app.context_panel = Some(ContextPanelState {
        title: "Context".to_string(),
        header: "snapshot".to_string(),
        rows,
        selected: 0,
    });
}
