use super::formatters::truncate_text;
use crate::app::runtime::UiPickRequest;
use crate::app::{
    ModelListPanelState, ModelListSubmitAction, ModelListViewMode, ModelSetScope,
    SessionListPanelState,
};
use serde_json::Value;

pub(super) fn parse_onboarding_model_provider(title: &str) -> Option<String> {
    let prefix = "Select model (";
    if !title.starts_with(prefix) || !title.ends_with(')') {
        return None;
    }
    let provider = title
        .strip_prefix(prefix)?
        .strip_suffix(')')?
        .trim()
        .to_string();
    if provider.is_empty() {
        return None;
    }
    Some(provider)
}

pub(super) fn parse_onboarding_model_costs(detail: Option<&str>) -> (String, String) {
    let Some(detail) = detail else {
        return ("-".to_string(), "-".to_string());
    };
    for part in detail.split('•').map(str::trim) {
        if let Some(raw) = part.strip_prefix("cost in/out ") {
            let raw = raw.strip_suffix(" USD per 1M").unwrap_or(raw);
            let (input, output) = raw.split_once('/').unwrap_or((raw, "-"));
            let input = input.trim();
            let output = output.trim();
            return (
                if input.is_empty() {
                    "-".to_string()
                } else {
                    input.to_string()
                },
                if output.is_empty() {
                    "-".to_string()
                } else {
                    output.to_string()
                },
            );
        }
    }
    ("-".to_string(), "-".to_string())
}

pub(super) fn build_onboarding_model_list_panel(
    request: &UiPickRequest,
) -> Option<ModelListPanelState> {
    if request.multi || request.items.is_empty() {
        return None;
    }
    let provider = parse_onboarding_model_provider(&request.title)?;

    let mut name_width = "model".len();
    let mut cost_input_width = "in$ /1M".len();
    let mut cost_output_width = "out$ /1M".len();
    let mut rows_limits = Vec::new();
    let mut rows_cost = Vec::new();
    let mut model_ids = Vec::new();
    let mut pick_item_ids = Vec::new();

    for item in &request.items {
        name_width = name_width.max(item.label.len());
        let (cost_in, cost_out) = parse_onboarding_model_costs(item.detail.as_deref());
        cost_input_width = cost_input_width.max(cost_in.len());
        cost_output_width = cost_output_width.max(cost_out.len());
        rows_limits.push(format!(
            "  {:<name_width$}  {:>3}  {:>2}  {:>3}",
            item.label, "-", "-", "-",
        ));
        rows_cost.push(format!(
            "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
            item.label, cost_in, cost_out,
        ));
        model_ids.push(item.label.clone());
        pick_item_ids.push(item.id.clone());
    }

    let header_limits = format!(
        "  {:<name_width$}  {:>3}  {:>2}  {:>3}",
        "model", "ctx", "in", "out",
    );
    let header_cost = format!(
        "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
        "model", "in$ /1M", "out$ /1M",
    );

    Some(ModelListPanelState {
        title: format!("Models ({provider}) current: -"),
        header_limits,
        rows_limits,
        header_cost,
        rows_cost,
        model_ids,
        selected: 0,
        view_mode: ModelListViewMode::Limits,
        submit_action: ModelListSubmitAction::UiPick {
            request_id: request.id.clone(),
            item_ids: pick_item_ids,
        },
    })
}

pub(super) fn format_context_file_row(file: &Value) -> Option<String> {
    let path = file.get("path").and_then(|value| value.as_str())?;
    let mtime = file
        .get("mtime_ms")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let size = file
        .get("size_bytes")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    Some(format!("- {path} (mtime={mtime}, size={size})"))
}

pub(super) fn format_session_updated(value: &str) -> String {
    let trimmed = value.trim_end_matches('Z').replace('T', " ");
    truncate_text(&trimmed, 19)
}

pub(super) fn build_session_list_panel(
    sessions: &[crate::protocol::SessionStateSummary],
    show_all: bool,
    current_workspace_root: Option<&str>,
) -> SessionListPanelState {
    let mut rows = Vec::new();
    let mut session_ids = Vec::new();
    for session in sessions {
        let session_id = session.session_id.clone();
        if session_id.is_empty() {
            continue;
        }
        let updated = format_session_updated(&session.updated_at);
        let count = session
            .message_count
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let preview = session
            .last_user_message
            .as_deref()
            .map(|value| value.replace('\n', " "))
            .unwrap_or_default();
        let preview = truncate_text(preview.trim(), 72);
        let short_id: String = session_id.chars().take(8).collect();
        let pinned = session.pinned.unwrap_or(false);
        let archived = session.archived_at.is_some();
        let flags = format!(
            "{}{}",
            if pinned { "[pinned] " } else { "" },
            if archived { "[archived] " } else { "" }
        );
        rows.push(format!(
            "{updated} | {count:>4} | {short_id} | {flags}{preview}"
        ));
        session_ids.push(session_id);
    }
    let workspace_label = current_workspace_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_text(value, 96));
    let title = if show_all {
        match workspace_label {
            Some(workspace) => format!(
                "Resume session — All sessions (current workspace: {workspace}; A: current workspace only)"
            ),
            None => "Resume session — All sessions (A: current workspace only)".to_string(),
        }
    } else {
        match workspace_label {
            Some(workspace) => {
                format!("Resume session — Current workspace: {workspace} (A: show all sessions)")
            }
            None => "Resume session — Current workspace only (A: show all sessions)".to_string(),
        }
    };
    SessionListPanelState {
        title,
        header: "Updated (UTC)       | Msgs | Session | Preview".to_string(),
        rows,
        session_ids,
        selected: 0,
        show_all,
    }
}

pub(super) fn build_model_list_panel(
    provider_label: String,
    current_label: String,
    models: Vec<String>,
    details: Option<&std::collections::BTreeMap<String, crate::protocol::ModelListDetails>>,
    current: Option<&str>,
    scope: ModelSetScope,
) -> ModelListPanelState {
    let format_usd = |value: Option<f64>| -> String {
        match value {
            Some(cost) if cost.is_finite() && cost >= 0.0 => {
                let fixed = format!("{cost:.4}");
                fixed
                    .trim_end_matches('0')
                    .trim_end_matches('.')
                    .to_string()
            }
            _ => "-".to_string(),
        }
    };

    let mut ctx_width = "ctx".len();
    let mut input_width = "in".len();
    let mut output_width = "out".len();
    let mut cost_input_width = "in$ /1M".len();
    let mut cost_output_width = "out$ /1M".len();
    let mut name_width = "model".len();
    let mut rows = Vec::new();
    let mut model_ids = Vec::new();
    for model in models {
        name_width = name_width.max(model.len());
        let model_id = model.clone();
        let detail = details.and_then(|map| map.get(&model));
        let count = |value: Option<i64>| {
            value
                .filter(|value| *value >= 0)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "-".to_string())
        };
        let ctx = count(detail.and_then(|d| d.context_window));
        let input = count(detail.and_then(|d| d.max_input_tokens));
        let output = count(detail.and_then(|d| d.max_output_tokens));
        let cost_input = format_usd(detail.and_then(|d| d.cost_per_1m_input_tokens_usd));
        let cost_output = format_usd(detail.and_then(|d| d.cost_per_1m_output_tokens_usd));
        ctx_width = ctx_width.max(ctx.len());
        input_width = input_width.max(input.len());
        output_width = output_width.max(output.len());
        cost_input_width = cost_input_width.max(cost_input.len());
        cost_output_width = cost_output_width.max(cost_output.len());
        let is_current = current == Some(model.as_str());
        rows.push((
            model,
            ctx,
            input,
            output,
            cost_input,
            cost_output,
            is_current,
        ));
        model_ids.push(model_id);
    }
    let header_limits = format!(
        "  {:<name_width$}  {:>ctx_width$}  {:>input_width$}  {:>output_width$}",
        "model", "ctx", "in", "out",
    );
    let header_cost = format!(
        "  {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
        "model", "in$ /1M", "out$ /1M",
    );
    let selected = rows
        .iter()
        .position(|(_, _, _, _, _, _, is_current)| *is_current)
        .unwrap_or(0);
    let rendered_rows_limits = rows
        .iter()
        .map(|(model, ctx, input, output, _, _, is_current)| {
            let marker = if *is_current { "*" } else { " " };
            format!(
                "{marker} {:<name_width$}  {:>ctx_width$}  {:>input_width$}  {:>output_width$}",
                model, ctx, input, output,
            )
        })
        .collect();
    let rendered_rows_cost = rows
        .into_iter()
        .map(|(model, _, _, _, cost_input, cost_output, is_current)| {
            let marker = if is_current { "*" } else { " " };
            format!(
                "{marker} {:<name_width$}  {:>cost_input_width$}  {:>cost_output_width$}",
                model, cost_input, cost_output,
            )
        })
        .collect();

    ModelListPanelState {
        title: format!("Models ({provider_label}) current: {current_label}"),
        header_limits,
        rows_limits: rendered_rows_limits,
        header_cost,
        rows_cost: rendered_rows_cost,
        model_ids,
        selected,
        view_mode: ModelListViewMode::Limits,
        submit_action: ModelListSubmitAction::ModelSet { scope },
    }
}
