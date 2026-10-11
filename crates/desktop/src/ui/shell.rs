use crate::{
    app::{Desktop, Quit, Send},
    application::Command,
};
use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable,
    button::*,
    input::Textarea,
    message_scroller::{MessageScroller, MessageScrollerState},
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
impl Render for Desktop {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.closing {
            return div()
                .size_full()
                .p_4()
                .child("Closing Codelia runtimes and owned tasks…")
                .into_any_element();
        }
        if self.workspaces.is_empty() {
            return div()
                .size_full()
                .flex()
                .flex_col()
                .justify_center()
                .items_center()
                .gap_3()
                .p_4()
                .child("Workspace unavailable. Select an existing folder to continue.")
                .child(
                    Button::new("open-startup-workspace")
                        .label("Open workspace…")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.pick_workspace(window, cx)),
                        ),
                )
                .into_any_element();
        }
        let foreground = cx.theme().foreground;
        let muted = cx.theme().muted_foreground;
        let bg = cx.theme().background;
        let border = cx.theme().border;
        let selected = self.selected;
        let ws = &self.workspaces[selected];
        let state = &ws.state;
        let busy = state.busy || state.draft_send_pending;
        let draft_send_pending = state.draft_send_pending;
        let loading = state.loading;
        let ready = state.connected;
        let status = state.status.clone();
        let model = state.model_label();
        let model_ready = state.model_ready();
        let model_error = state.model_error.clone();
        let catalog_provider = state.catalog_provider.clone();
        let error = state.error.clone();
        let key = state.key();
        let title = state
            .conversations
            .get(&key)
            .map(|conversation| conversation.title.as_str())
            .filter(|title| !title.is_empty())
            .unwrap_or("New session")
            .to_owned();
        let request = state.request.clone();
        let root = ws.root.to_string_lossy().into_owned();

        let models = state.models.clone();
        let context = state
            .context
            .map(|p| format!("Context {p:.0}% left"))
            .unwrap_or_else(|| "Context —".into());
        let scroll = self
            .scrolls
            .entry((selected, key))
            .or_insert_with(|| cx.new(|cx| MessageScrollerState::new(0, cx)))
            .clone();
        let weak = cx.weak_entity();
        let transcript = MessageScroller::new("conversation", scroll, move |index, _window, cx| {
            weak.update(cx, |this, cx| {
                let row = this.ws().state.rows().get(index).cloned();
                row.map(|row| this.row(row, cx))
                    .unwrap_or_else(|| div().into_any_element())
            })
            .unwrap_or_else(|_| div().into_any_element())
        })
        .with_row_style(StyleRefinement::default().px_0().pb_1())
        .flex_1()
        .min_h_0();
        let running_children = state
            .child_tasks()
            .filter(|task| task["state"] == "running" || task["state"] == "queued")
            .count();
        let attention = if state.request.is_some() {
            " · input needed"
        } else {
            ""
        };
        let activity = format!(
            "{}{attention}{}",
            match status.as_str() {
                "awaiting_ui" => "Waiting",
                "completed" => "Completed",
                "cancelled" => "Stopped",
                "running" => "Running",
                "error" => "Error",
                "Ready" if !model_ready => "Connected · choose a model",
                "Ready" => "Ready to send",
                _ => &status,
            },
            if running_children > 0 {
                format!(" · {running_children} children running")
            } else {
                String::new()
            }
        );
        let changes_count = ws.git.status.lines().count();
        let changes_summary = if ws.git.error.is_some() {
            "unavailable".to_owned()
        } else {
            format!("{changes_count} files")
        };
        let changes_count_label = if ws.git.error.is_some() {
            "—".to_owned()
        } else {
            changes_count.to_string()
        };
        let inspector = state.inspector != crate::state::Inspector::None;
        let viewport_width = f32::from(window.viewport_size().width);
        let sidebar_visible = self.show_sidebar && (!inspector || viewport_width >= 1000.);
        let conversation_width = viewport_width
            - if sidebar_visible { 220. } else { 0. }
            - if inspector { 340. } else { 0. };
        let compact_header = conversation_width < 640.;
        let navigation_label = if sidebar_visible {
            "Hide sessions"
        } else {
            "Show sessions"
        };
        let changes_label = if state.inspector == crate::state::Inspector::Changes {
            "Close changes"
        } else {
            "Show changes"
        };
        let sidebar = self.render_sidebar(cx);
        let mut header = div()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(border)
            .child(
                Button::new("navigation")
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::PanelLeft)
                    .accessibility_label(navigation_label)
                    .tooltip(navigation_label)
                    .flex_shrink_0()
                    .on_click(cx.listener(|this, _, window, cx| {
                        // At narrow widths navigation and inspector cannot fit together.
                        // The button must reveal navigation even when it was hidden by a panel.
                        if this.ws().state.inspector != crate::state::Inspector::None
                            && window.viewport_size().width < px(1000.)
                        {
                            let _ = this.ws().command(Command::CloseInspector);
                            this.show_sidebar = true;
                        } else {
                            this.show_sidebar = !this.show_sidebar;
                        }
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_ellipsis()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .when(compact_header, |title| {
                        title.child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .text_ellipsis()
                                .child(activity.clone()),
                        )
                    }),
            )
            .when(!compact_header, |header| {
                header.child(
                    div()
                        .min_w_0()
                        .text_xs()
                        .text_color(muted)
                        .max_w(px(240.))
                        .text_ellipsis()
                        .child(activity),
                )
            })
            .child(
                Button::new("changes")
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::FileDiff)
                    .label(changes_count_label)
                    .accessibility_label(format!("{changes_label} · {changes_summary}"))
                    .tooltip(changes_label)
                    .flex_shrink_0()
                    .on_click(cx.listener(|this, _, _, cx| {
                        let command =
                            if this.ws().state.inspector == crate::state::Inspector::Changes {
                                Command::CloseInspector
                            } else {
                                Command::OpenChanges
                            };
                        if let Err(error) = this.ws().command(command) {
                            this.ws().state.error = Some(error);
                        }
                        cx.notify();
                    })),
            );
        if !ready {
            header = header.child(
                Button::new("reconnect")
                    .small()
                    .label("Reconnect")
                    .flex_shrink_0()
                    .on_click(cx.listener(|this, _, _, cx| {
                        let options = this.runtime_options.clone();
                        this.ws().connect(&options);
                        cx.notify();
                    })),
            );
        }
        let mut center = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(header);
        if self.ws().state.rows().is_empty() {
            center =
                center.child(
                    div()
                        .flex_1()
                        .p_4()
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Start a session"),
                        )
                        .child(div().mt_2().text_color(muted).child(
                            "Ask Codelia to inspect, implement, or explain in this workspace.",
                        )),
                );
        } else {
            center = center.child(transcript);
        }
        if let Some(request) = request {
            center = center.child(self.render_request(request, root.clone(), window, cx));
        }
        if let Some(error) = error {
            center = center.child(
                div()
                    .mx_4()
                    .p_3()
                    .rounded_md()
                    .bg(cx.theme().danger.opacity(0.12))
                    .text_color(cx.theme().danger)
                    .child(error),
            );
        }
        if let Some(error) = model_error {
            center = center.child(
                div()
                    .mx_3()
                    .p_2()
                    .text_sm()
                    .text_color(cx.theme().danger)
                    .child(format!(
                        "Model unavailable: {error}. Choose a provider and model below."
                    )),
            );
        }
        let mut composer = div()
            .key_context("Composer")
            .mx_3()
            .mb_3()
            .p_2()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap_1()
            .rounded_md()
            .border_1()
            .border_color(border)
            .child(
                Textarea::new(&self.composer)
                    .h(px(64.))
                    .bordered(false)
                    .aria_label("Message Codelia")
                    .disabled(loading || self.closing),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .gap_2()
                    .child(
                        Button::new("model")
                            .ghost()
                            .small()
                            .label(if model_ready {format!("Model · {model}")} else {model.clone()})
                            .tooltip(format!("Choose provider and model for this session · {context}"))
                            .min_w_0()
                            .max_w(px((conversation_width - 144.).max(140.)))
                            .overflow_hidden()
                            .disabled(busy || loading || !ready)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_models = !this.show_models;
                                cx.notify();
                            })),
                    )
                    .child(if busy {
                        Button::new("stop")
                            .small()
                            .label(if draft_send_pending {"Cancel send"} else {"Stop"})
                            .accessibility_label(if draft_send_pending {"Cancel draft send"} else {"Stop parent turn"})
                            .tooltip(if draft_send_pending {"Cancels this send before runtime admission; the draft is retained."} else {"Stops this parent turn. Child agents continue until cancelled separately."})
                            .flex_shrink_0()
                            .disabled(self.ws().state.cancel_pending)
                            .on_click(cx.listener(|this, _, window, cx| {
                                match this.ws().command(Command::Cancel) {
                                    Ok(value) if value["draft_send_cancelled"]==true => {this.restore_draft(window,cx);this.composer.focus_handle(cx).focus(window,cx);},
                                    Ok(_) => {},
                                    Err(error) => this.ws().state.error=Some(error),
                                }
                                cx.notify();
                            }))
                    } else {
                        Button::new("send")
                            .primary()
                            .small()
                            .label("Send  ⌘↵")
                            .flex_shrink_0()
                            .disabled(
                                !ready
                                    || !model_ready
                                    || loading
                                    || self.composer.read(cx).value().trim().is_empty()
                                    || self.ws().state.request.is_some(),
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.send_prompt(window, cx)),
                            )
                    }),
            );
        if self.show_models || !model_ready {
            let mut menu = div()
                .id("model-list")
                .max_h(px(160.))
                .overflow_y_scroll()
                .flex()
                .flex_col();
            menu = menu.child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("Choose provider · applies to this session"),
            );
            let mut providers = div().flex().flex_wrap().gap_1();
            for (provider_index, (provider, label)) in
                crate::state::MODEL_PROVIDERS.into_iter().enumerate()
            {
                providers = providers.child(
                    Button::new(("model-provider", provider_index))
                        .ghost()
                        .small()
                        .label(label)
                        .disabled(!ready || busy || loading)
                        .tooltip("Show local models; your saved settings and sign-in are unchanged")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(error) =
                                this.ws().command(Command::ListModels(provider.into()))
                            {
                                this.ws().state.model_error = Some(error);
                            }
                            this.show_models = true;
                            cx.notify();
                        })),
                );
            }
            menu = menu.child(providers);
            if models.is_empty() {
                menu = menu.child(div().text_xs().text_color(muted).child(
                    if self.ws().state.has_pending("model.list") {
                        "Loading model list…"
                    } else if catalog_provider.is_empty() {
                        "Select a provider to see models."
                    } else {
                        "No built-in models available. Select another provider."
                    },
                ));
            }
            for (index, name) in models.into_iter().enumerate() {
                let catalog_provider = catalog_provider.clone();
                menu = menu.child(
                    Button::new(("model-option", index))
                        .ghost()
                        .label(name.clone())
                        .disabled(
                            !ready
                                || busy
                                || loading
                                || !self.ws().state.supports_run_model
                                || self.ws().state.has_pending("model.list"),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(error) = this.ws().command(Command::ChooseModel {
                                provider: catalog_provider.clone(),
                                name: name.clone(),
                            }) {
                                this.ws().state.error = Some(error);
                            }
                            this.show_models = false;
                            cx.notify();
                        })),
                );
            }
            composer = composer.child(menu);
        }
        if self.ws().state.last_prompt.is_some()
            && self.ws().state.retryable
            && !busy
            && self.ws().state.error.is_some()
            && ready
        {
            composer = composer.child(
                Button::new("retry")
                    .label("Edit last prompt to retry…")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.save_draft(cx);
                        if let Some(owner) = this.ws().state.run_owner.clone()
                            && let Err(error) = this.ws().command(Command::SelectThread(owner))
                        {
                            this.ws().state.error = Some(error);
                            return;
                        }
                        let text = this.ws().state.last_prompt.clone().unwrap_or_default();
                        this.composer
                            .update(cx, |state, cx| state.set_value(text, window, cx));
                        cx.notify();
                    })),
            );
        }
        let draft_notice = self.ws().state.draft_notice.clone();
        composer = composer.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(draft_notice.unwrap_or_default()),
                )
                .child(
                    Button::new("clear-draft")
                        .ghost()
                        .small()
                        .label("Clear draft")
                        .disabled(busy || loading || self.composer.read(cx).value().is_empty())
                        .on_click(cx.listener(|this, _, window, cx| this.clear_draft(window, cx))),
                ),
        );
        if self
            .ws()
            .state
            .draft_notice
            .as_deref()
            .is_some_and(|notice| notice.starts_with("Draft not saved. Window kept open"))
        {
            composer = composer.child(
                Button::new("quit-without-saving")
                    .ghost()
                    .small()
                    .label("Quit without saving")
                    .on_click(cx.listener(|this, _, _, cx| this.quit_without_saving(cx))),
            );
        }
        center = center.child(composer);
        let mut content = div().flex().flex_1().min_h_0();
        if sidebar_visible {
            content = content.child(sidebar);
        }
        content = content.child(center);
        if self.ws().state.inspector == crate::state::Inspector::Task {
            content = content.child(self.render_tasks(cx));
        }
        if self.ws().state.inspector == crate::state::Inspector::Changes {
            content = content.child(self.render_changes(cx));
        }
        div()
            .key_context("Codelia")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &Quit, _, cx| this.request_quit(cx)))
            .on_action(cx.listener(|this, _: &Send, window, cx| this.send_prompt(window, cx)))
            .size_full()
            .bg(bg)
            .text_color(foreground)
            .font_family(".AppleSystemUIFont")
            .text_sm()
            .flex()
            .flex_col()
            .child(content)
            .into_any_element()
    }
}
