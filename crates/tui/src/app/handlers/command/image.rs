use crate::app::runtime::{send_request, wire_value, RuntimeTx};
use crate::app::state::LogKind;
use crate::app::{AppState, PendingImageArtifactRequest};
use crate::protocol::{
    methods, ImageArtifactGetParams, ImageModelConfigureParams, ImageModelGetParams,
};
use serde_json::{json, Value};

fn model_params(args: &str) -> Result<(&'static str, Value), &'static str> {
    let parts: Vec<_> = args.split_whitespace().collect();
    match parts.as_slice() {
        [] => Ok(("image.model.configure", json!({}))),
        ["status"] => Ok(("image.model.get", json!({}))),
        ["off"] => Ok(("image.model.configure", json!({"mode":"off"}))),
        ["builtin"] => Ok(("image.model.configure", json!({"mode":"builtin"}))),
        ["builtin", model] => Ok(("image.model.configure", json!({"mode":"builtin", "model":model}))),
        [provider, model] if *provider == "openai" => Ok(("image.model.configure", json!({"mode":"custom", "provider":provider, "model":model}))),
        ["google", model] => Ok(("image.model.configure", json!({"mode":"custom", "provider":"google", "model":model}))),
        ["google", model, size] if ["1K", "2K", "4K"].contains(size) => Ok(("image.model.configure", json!({"mode":"custom", "provider":"google", "model":model, "image_size":size}))),
        ["google", model, size, ratio] if ["1K", "2K", "4K"].contains(size) => Ok(("image.model.configure", json!({"mode":"custom", "provider":"google", "model":model, "image_size":size, "aspect_ratio":ratio}))),
		["google", model, size, ratio, "jpeg"] if ["1K", "2K", "4K"].contains(size) => Ok(("image.model.configure", json!({"mode":"custom", "provider":"google", "model":model, "image_size":size, "aspect_ratio":ratio, "output_format":"jpeg"}))),
        [provider, model, endpoint] if *provider == "openrouter" => Ok(("image.model.configure", json!({"mode":"custom", "provider":provider, "model":model, "endpoint":endpoint}))),
        _ => Err("usage: /image-model [status|off|builtin [model]|openai <model>|openrouter <model> <endpoint>|google <model> [1K|2K|4K [ratio [jpeg]]]]"),
    }
}

pub(super) fn handle(app: &mut AppState, tx: &mut dyn RuntimeTx, args: &str, artifact: bool) {
    if !app.runtime_info.supports_image_generation {
        app.push_line(LogKind::Error, "Image generation/artifacts are unavailable in this runtime. Update the runtime or use a supported local environment.");
        return;
    }
    if app.rpc_pending.image_model_get_id.is_some()
        || app.rpc_pending.image_model_configure_id.is_some()
        || app.rpc_pending.image_artifact_id.is_some()
        || app.runtime_info.active_run_id.is_some()
    {
        app.push_line(
            LogKind::Status,
            "Wait for the current run or image request to finish.",
        );
        return;
    }
    let (method, params) = if artifact {
        if !args.starts_with("codelia-image-")
            || args.len() != 50
            || !args[14..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-')
        {
            app.push_line(
                LogKind::Error,
                "usage: /image-artifact <codelia-image-id> (not a path or URL)",
            );
            return;
        }
        ("image.artifact.get", json!({"artifact_id":args}))
    } else {
        match model_params(args) {
            Ok(request) => request,
            Err(message) => {
                app.push_line(LogKind::Error, message);
                return;
            }
        }
    };
    let id = tx.next_id();
    if artifact {
        app.rpc_pending.image_artifact_id = Some(PendingImageArtifactRequest {
            request_id: id.clone(),
            artifact_id: args.to_string(),
            preview_revision: app.image_preview.revision(),
        });
    } else if method == "image.model.get" {
        app.rpc_pending.image_model_get_id = Some(id.clone());
    } else {
        app.rpc_pending.image_model_configure_id = Some(id.clone());
    }
    let sent = match method {
        "image.artifact.get" => send_request::<methods::ImageArtifactGet>(
            tx,
            &id,
            &ImageArtifactGetParams {
                artifact_id: args.to_string(),
            },
        ),
        "image.model.get" => {
            send_request::<methods::ImageModelGet>(tx, &id, &ImageModelGetParams::default())
        }
        _ => wire_value::<ImageModelConfigureParams>("image.model.configure", "params", params)
            .and_then(|params| send_request::<methods::ImageModelConfigure>(tx, &id, &params)),
    };
    if let Err(error) = sent {
        app.rpc_pending.image_artifact_id = None;
        app.rpc_pending.image_model_get_id = None;
        app.rpc_pending.image_model_configure_id = None;
        app.push_error_report("send image request", error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_selection_never_sets_the_conversation_model() {
        for args in [
            "",
            "status",
            "off",
            "builtin",
            "openai gpt-image-2.5-sunburst",
            "openrouter owner/model endpoint",
            "google gemini-nano-banana-2.1 4K 1:1 jpeg",
        ] {
            let (method, params) = model_params(args).unwrap();
            assert!(method.starts_with("image.model."));
            assert!(params.get("api_key").is_none());
        }
        assert!(model_params("openrouter owner/model").is_err());
        assert!(model_params("off extra").is_err());
    }
}
