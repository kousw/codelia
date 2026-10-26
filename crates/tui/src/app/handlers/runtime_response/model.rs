use super::formatters::push_rpc_error;
use super::panel_builders::build_model_list_panel;
use crate::app::runtime::RpcResponse;
use crate::app::state::LogKind;
use crate::app::ModelFastMode;
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
    if let Some(providers) = result.get("providers").and_then(|value| value.as_array()) {
        app.runtime_info.model_providers = providers
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
    }
    app.runtime_info.model_reasoning_levels = result
        .get("reasoning_levels")
        .and_then(|value| value.as_object())
        .map(|models| {
            models
                .iter()
                .map(|(model, levels)| {
                    (
                        model.clone(),
                        levels
                            .as_array()
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(|item| item.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
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
    let fast = result.get("fast").and_then(ModelFastMode::from_value);
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
        let fast = result.get("fast").and_then(ModelFastMode::from_value);
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
                suffix_parts.push(fast.label().to_string());
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

#[cfg(test)]
mod responses_provider_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_list_applies_configured_providers_and_reasoning_limits() {
        let mut app = AppState::default();
        apply_model_list_result(
            &mut app,
            ModelListMode::Picker,
            ModelSetScope::Config,
            &json!({
                "provider": "home", "providers": ["openai", "home"],
                "models": ["strata", "text-only"], "current": "strata",
                "reasoning_levels": { "strata": ["low", "medium", "high"], "text-only": [] }
            }),
        );
        assert_eq!(app.runtime_info.current_provider.as_deref(), Some("home"));
        assert_eq!(app.runtime_info.model_providers, ["openai", "home"]);
        assert_eq!(
            app.runtime_info.model_reasoning_levels["strata"],
            ["low", "medium", "high"]
        );
        assert!(app.runtime_info.model_reasoning_levels["text-only"].is_empty());
        assert_eq!(
            app.model_picker.expect("model picker").models,
            ["strata", "text-only"]
        );
    }
    #[test]
    fn model_response_restores_ultrafast_and_boolean_modes() {
        let mut app = AppState::default();
        for (wire, expected) in [
            (json!("ultrafast"), ModelFastMode::Ultrafast),
            (json!(true), ModelFastMode::Fast),
            (json!(false), ModelFastMode::Off),
        ] {
            apply_model_list_result(
                &mut app,
                ModelListMode::Silent,
                ModelSetScope::Session,
                &json!({"provider":"openai","models":["gpt-6.1-sol"],"current":"gpt-6.1-sol","fast":wire}),
            );
            assert_eq!(app.runtime_info.current_fast, Some(expected));
        }
    }
}
