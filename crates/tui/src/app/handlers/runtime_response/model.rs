use super::formatters::push_rpc_error;
use super::panel_builders::build_model_list_panel;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::{AppState, ModelListMode, ModelPickerState, ModelSetScope};
use serde_json::Value;

pub(super) fn handle_model_list_response(
    app: &mut AppState,
    mode: ModelListMode,
    scope: ModelSetScope,
    response: RpcResponse,
) {
    if let Some(error) = response.error {
        push_rpc_error(app, "model.list", &error);
        return;
    }
    if let Some(result) = response.result {
        apply_model_list_result(app, mode, scope, &result);
    }
}

fn apply_model_list_result(
    app: &mut AppState,
    mode: ModelListMode,
    scope: ModelSetScope,
    result: &Value,
) {
    let provider = result
        .get("provider")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let models = result
        .get("models")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let current = result
        .get("current")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let reasoning = result
        .get("reasoning")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let fast = result.get("fast").and_then(|value| value.as_bool());
    let source = result
        .get("source")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if let Some(provider) = provider.clone() {
        app.runtime_info.current_provider = Some(provider);
    }
    app.runtime_info.current_model = current.clone();
    if let Some(reasoning) = reasoning {
        app.runtime_info.current_reasoning = Some(reasoning);
    }
    if let Some(fast) = fast {
        app.runtime_info.current_fast = Some(fast);
    }
    if let Some(source) = source {
        app.runtime_info.current_model_source = Some(source);
    }
    app.skills_list_panel = None;
    app.theme_list_panel = None;
    if matches!(mode, ModelListMode::Silent) {
        return;
    }
    if models.is_empty() {
        app.push_line(LogKind::Error, "model.list returned no models");
        return;
    }

    if matches!(mode, ModelListMode::Picker) {
        app.model_list_panel = None;
        app.reasoning_picker = None;
        let selected = current
            .as_ref()
            .and_then(|value| models.iter().position(|model| model == value))
            .unwrap_or(0);
        app.model_picker = Some(ModelPickerState { models, selected });
        return;
    }

    app.model_picker = None;
    app.reasoning_picker = None;
    let details = result.get("details").and_then(|value| value.as_object());
    let provider_label = provider
        .or_else(|| app.runtime_info.current_provider.clone())
        .unwrap_or_else(|| "openai".to_string());
    let current_label = current.clone().unwrap_or_else(|| "-".to_string());
    app.model_list_panel = Some(build_model_list_panel(
        provider_label,
        current_label,
        models,
        details,
        current.as_deref(),
        scope,
    ));
}

pub(super) fn handle_model_set_response(app: &mut AppState, response: RpcResponse) {
    if let Some(error) = response.error {
        push_rpc_error(app, "model.set", &error);
        return;
    }
    if let Some(result) = response.result {
        let name = result
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let provider = result
            .get("provider")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let reasoning = result
            .get("reasoning")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let fast = result.get("fast").and_then(|value| value.as_bool());
        let source = result
            .get("source")
            .and_then(|value| value.as_str())
            .unwrap_or("config");
        if !name.is_empty() {
            app.runtime_info.current_model = Some(name.to_string());
            if !provider.is_empty() {
                app.runtime_info.current_provider = Some(provider.to_string());
            }
            if !reasoning.is_empty() {
                app.runtime_info.current_reasoning = Some(reasoning.to_string());
            }
            if let Some(fast) = fast {
                app.runtime_info.current_fast = Some(fast);
            }
            app.runtime_info.current_model_source = Some(source.to_string());
            let mut suffix_parts = Vec::new();
            if !reasoning.is_empty() {
                suffix_parts.push(reasoning.to_string());
            }
            if let Some(fast) = fast {
                suffix_parts.push(if fast { "fast" } else { "fast:off" }.to_string());
            }
            if source == "session" {
                suffix_parts.push("session".to_string());
            }
            let suffix = if suffix_parts.is_empty() {
                String::new()
            } else {
                format!(" [{}]", suffix_parts.join(", "))
            };
            app.push_line(
                LogKind::Status,
                format!(
                    "{}: {provider}/{name}{suffix}",
                    if source == "session" {
                        "Model set for this session"
                    } else {
                        "Model saved to config"
                    }
                ),
            );
            app.push_line(LogKind::Space, "");
        }
    }
}
