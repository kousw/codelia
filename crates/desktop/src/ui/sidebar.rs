use crate::{app::Desktop, application::Command};
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, button::*};
use gpui_kit::*;

// Kit centers its label container independently of the outer button style.
// A full-width child gives navigation rows a consistent left text edge.
trait NavigationLabel {
    fn navigation_label(self, label: impl Into<SharedString>) -> Self;
}
impl NavigationLabel for Button {
    fn navigation_label(self, label: impl Into<SharedString>) -> Self {
        let label = label.into();
        self.accessibility_label(label.clone())
            .child(div().w_full().min_w_0().text_ellipsis().child(label))
    }
}

impl Desktop {
    pub(crate) fn render_sidebar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.selected;
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let selection = rgb(0xeaeaed);
        let state = &self.workspaces[selected].state;
        let busy = state.busy;
        let loading = state.loading;
        let ready = state.connected;
        let session = state.session.clone();
        let sessions = state.sessions.clone();
        let worktree_list = state.worktree_list.clone();
        let worktree_error = state.worktree_error.clone();
        let worktree_operation = state.worktree_operation.clone();
        let worktrees_enabled = state.supports_worktrees;
        let creating_worktree = state.has_pending("worktree.create");
        let mut sidebar = div()
            .id("workspace-navigation")
            .overflow_y_scroll()
            .w(px(220.))
            .flex_shrink_0()
            .h_full()
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .bg(rgb(0xfafafa))
            .border_r_1()
            .border_color(border)
            .child(
                Button::new("open")
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::FolderOpen)
                    .navigation_label("Open workspace…")
                    .on_click(cx.listener(|this, _, window, cx| this.pick_workspace(window, cx))),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .mt_2()
                    .px_2()
                    .child("Workspaces"),
            );
        for (index, workspace) in self.workspaces.iter().enumerate() {
            let label = workspace
                .root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let parent = workspace
                .root
                .parent()
                .and_then(|p| p.file_name())
                .unwrap_or_default()
                .to_string_lossy();
            let identity = format!("{parent} / {label}");
            let duplicates = self
                .workspaces
                .iter()
                .filter(|ws| ws.root.file_name() == workspace.root.file_name())
                .count()
                > 1;
            let display = if duplicates {
                let components: Vec<_> = workspace
                    .root
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                let mut suffix = identity.clone();
                for count in 2..=components.len() {
                    let candidate = components[components.len() - count..].join("/");
                    if self
                        .workspaces
                        .iter()
                        .filter(|ws| ws.root.ends_with(std::path::Path::new(&candidate)))
                        .count()
                        == 1
                    {
                        suffix = candidate;
                        break;
                    }
                }
                suffix
            } else {
                label.clone()
            };
            let running = workspace.state.busy;
            sidebar = sidebar.child(
                Button::new(("workspace", index))
                    .ghost()
                    .small()
                    .navigation_label(if running {
                        format!("{display} · running")
                    } else {
                        display
                    })
                    .tooltip(workspace.root.to_string_lossy().into_owned())
                    .bg(if index == selected {
                        selection.into()
                    } else {
                        transparent_black()
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.save_draft(cx);
                        this.selected = index;
                        this.restore_draft(window, cx);
                        this.composer.focus_handle(cx).focus(window, cx);
                        cx.notify();
                    })),
            );
        }
        if worktrees_enabled {
            sidebar = sidebar.child(
                div().flex().items_center().justify_between().mt_2().px_2()
                    .child(div().text_xs().text_color(muted).child("Related worktrees"))
                    .child(Button::new("refresh-worktrees").ghost().small()
                        .label("Refresh").disabled(!ready)
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Err(error) = this.ws().command(Command::ListWorktrees) { this.ws().state.worktree_error = Some(error); }
                            cx.notify();
                        }))),
            ).child(Button::new("new-worktree").ghost().small()
                .navigation_label(if creating_worktree { "Creating worktree…" } else { "New worktree from HEAD…" })
                .tooltip("Create from the committed HEAD. Source uncommitted changes stay in place. Confirm the exact destination before creation.")
                .disabled(!ready || loading || creating_worktree || worktree_list.is_none() || self.ws().state.request.is_some() || worktree_error.as_ref().is_some_and(|e|e.contains("checkout filters")))
                .on_click(cx.listener(|this, _, _, cx| {
                    let operation_id = format!("desktop-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
                    let origin_thread = this.ws().state.key();
                    if let Err(error) = this.ws().command(Command::CreateWorktree { operation_id, title: "New task".into(), base_ref: "HEAD".into(), origin_thread, run_id: None }) { this.ws().state.worktree_error = Some(error); }
                    cx.notify();
                })));
            let mut list = div()
                .id("worktrees")
                .max_h(px(136.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap_1();
            if let Some(items) = worktree_list
                .as_ref()
                .and_then(|v| v["worktrees"].as_array())
            {
                for (index, item) in items.iter().enumerate() {
                    let path = item["path"].as_str().unwrap_or("").to_owned();
                    let branch = item["branch"].as_str().unwrap_or("Detached HEAD");
                    let status = if item["available"] != true {
                        "unavailable".to_owned()
                    } else if item["dirty"] == true {
                        format!("{} changes", item["changed_files"])
                    } else if item["dirty"] == false {
                        "clean".to_owned()
                    } else {
                        "not checked".to_owned()
                    };
                    let detail = format!(
                        "{}\n{branch} · {status}\n{}",
                        path,
                        item["error"].as_str().unwrap_or(
                            "Open this checkout; its sessions stay scoped to this worktree."
                        )
                    );
                    let folder = std::path::Path::new(&path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    let label = if item["current"] == true {
                        format!("Current · {folder}")
                    } else {
                        folder.into_owned()
                    };
                    let subtitle = if item["current"] == true {
                        format!("{branch} · {status}")
                    } else {
                        branch.to_owned()
                    };
                    list = list.child(
                        Button::new(("worktree", index))
                            .ghost()
                            .small()
                            .h(px(40.))
                            .accessibility_label(format!("{label} · {subtitle}"))
                            .child(
                                div()
                                    .w_full()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .items_start()
                                    .child(div().w_full().text_ellipsis().child(label))
                                    .child(
                                        div()
                                            .w_full()
                                            .text_xs()
                                            .text_color(muted)
                                            .text_ellipsis()
                                            .child(subtitle),
                                    ),
                            )
                            .tooltip(detail)
                            .disabled(item["available"] != true || !ready)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                match this.ws().command(Command::OpenWorktree(path.clone())) {
                                    Ok(value) => {
                                        if let Some(path) = value["open_workspace"].as_str() {
                                            this.open_workspace(
                                                std::path::PathBuf::from(path),
                                                window,
                                                cx,
                                            );
                                        }
                                    }
                                    Err(error) => this.ws().state.worktree_error = Some(error),
                                }
                                cx.notify();
                            })),
                    );
                }
            }
            if let Some(operations) = worktree_list
                .as_ref()
                .and_then(|v| v["operations"].as_array())
            {
                for (index, op) in operations
                    .iter()
                    .enumerate()
                    .filter(|(_, op)| op["phase"] == "unknown")
                {
                    let detail = format!(
                        "Operation: {}\nRecorded phase: {}\nOrigin thread: {}\nDestination: {}\n{}",
                        op["operation_id"].as_str().unwrap_or("unknown"),
                        op["recorded_phase"].as_str().unwrap_or("unreadable"),
                        op["thread_id"].as_str().unwrap_or("unknown"),
                        op["path"].as_str().unwrap_or("unknown"),
                        op["error"].as_str().unwrap_or("Outcome unknown; no replay")
                    );
                    list = list.child(
                        Button::new(("unknown-worktree", index))
                            .ghost()
                            .small()
                            .navigation_label(format!(
                                "{} · outcome unknown",
                                op["title"].as_str().unwrap_or("Worktree")
                            ))
                            .tooltip(detail.clone())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.ws().state.worktree_error = Some(detail.clone());
                                cx.notify();
                            })),
                    );
                }
            }
            sidebar = sidebar.child(list);
            if let Some(error) = worktree_error {
                sidebar = sidebar.child(
                    div()
                        .px_2()
                        .text_xs()
                        .text_color(muted)
                        .child(if error.contains("checkout filters") {
                            "Create unavailable: checkout setup required"
                        } else {
                            "Worktree action needs attention"
                        })
                        .child(
                            Button::new("worktree-error-details")
                                .ghost()
                                .small()
                                .label(if self.ws().state.show_worktree_details {
                                    "Hide details"
                                } else {
                                    "Details"
                                })
                                .tooltip(error.clone())
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.ws().state.show_worktree_details =
                                        !this.ws().state.show_worktree_details;
                                    cx.notify();
                                })),
                        ),
                );
                if self.ws().state.show_worktree_details {
                    sidebar = sidebar.child(
                        div()
                            .id("worktree-diagnostic")
                            .max_h(px(80.))
                            .overflow_y_scroll()
                            .text_xs()
                            .text_color(muted)
                            .px_2()
                            .child(error),
                    );
                }
            } else if let Some(op) = worktree_operation {
                sidebar = sidebar.child(div().text_xs().text_color(muted).px_2().child(format!(
                    "Worktree: {}",
                    op["phase"].as_str().unwrap_or("unknown")
                )));
            }
        }
        sidebar = sidebar
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .mt_2()
                    .px_2()
                    .child("Sessions"),
            )
            .child(
                Button::new("new")
                    .ghost()
                    .small()
                    .icon(gpui_kit::assets::IconName::Plus)
                    .navigation_label("New session")
                    .disabled(loading || !ready)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.select_session(None, window, cx)),
                    ),
            );
        let mut session_list = div()
            .id("sessions")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_1();
        for (index, item) in sessions.iter().enumerate() {
            let id = item["session_id"].as_str().unwrap_or("").to_owned();
            if self.ws().state.conversations.contains_key(&id) {
                continue;
            }
            let title = item["last_user_message"]
                .as_str()
                .unwrap_or(&id)
                .chars()
                .take(34)
                .collect::<String>();
            session_list = session_list.child(
                Button::new(("session", index))
                    .ghost()
                    .small()
                    .navigation_label(format!(
                        "{}{title}",
                        if session.as_deref() == Some(&id) {
                            "● "
                        } else {
                            ""
                        }
                    ))
                    .disabled(busy || loading)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_session(Some(id.clone()), window, cx)
                    })),
            );
        }
        let mut cached: Vec<_> = self
            .ws()
            .state
            .conversations
            .iter()
            .map(|(id, c)| (id.clone(), c.title.clone()))
            .collect();
        cached.sort_by(|a, b| a.0.cmp(&b.0));
        for (index, (id, title)) in cached.into_iter().enumerate() {
            let running = self.ws().state.busy && self.ws().state.run_owner.as_deref() == Some(&id);
            session_list = session_list.child(
                Button::new(("loaded-thread", index))
                    .ghost()
                    .small()
                    .navigation_label(format!(
                        "{}{}",
                        if self.ws().state.key() == id {
                            ""
                        } else if running {
                            "↳ "
                        } else {
                            ""
                        },
                        if title.is_empty() {
                            "New session".into()
                        } else {
                            title.chars().take(34).collect::<String>()
                        }
                    ))
                    .bg(if self.ws().state.key() == id {
                        selection.into()
                    } else {
                        transparent_black()
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.save_draft(cx);
                        if let Err(error) = this.ws().command(Command::SelectThread(id.clone())) {
                            this.ws().state.error = Some(error);
                        }
                        this.restore_draft(window, cx);
                        this.composer.focus_handle(cx).focus(window, cx);
                        cx.notify();
                    })),
            );
        }
        sidebar = sidebar.child(session_list);
        let mut tasks: Vec<_> = self.ws().state.child_tasks().cloned().collect();
        tasks.sort_by(|a, b| {
            a["subagent"]["owner_session_id"]
                .as_str()
                .cmp(&b["subagent"]["owner_session_id"].as_str())
        });
        if !tasks.is_empty() {
            let mut tree = div()
                .id("agent-tree")
                .max_h(px(200.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .px_2()
                        .child("Child agents"),
                );
            let mut previous_parent = String::new();
            for (index, task) in tasks.iter().enumerate() {
                let id = task["task_id"].as_str().unwrap_or("").to_owned();
                let parent = task["subagent"]["owner_session_id"].as_str().unwrap_or("");
                let title = self
                    .ws()
                    .state
                    .conversations
                    .get(parent)
                    .map(|c| c.title.as_str())
                    .unwrap_or("Parent session");
                let name = task["name"]
                    .as_str()
                    .or(task["title"].as_str())
                    .unwrap_or(&id);
                let label = format!("↳ {name} · {}", task["state"].as_str().unwrap_or("unknown"));
                if previous_parent != parent {
                    tree = tree.child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .text_ellipsis()
                            .child(title.to_owned()),
                    );
                    previous_parent = parent.to_owned();
                }
                tree = tree.child(
                    Button::new(("child-agent", index))
                        .ghost()
                        .small()
                        .navigation_label(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(error) = this.ws().command(Command::TaskStatus(id.clone())) {
                                this.ws().state.error = Some(error);
                            }
                            cx.notify();
                        })),
                );
            }
            sidebar = sidebar.child(tree);
        }
        if busy {
            sidebar =
                sidebar.child(div().text_xs().text_color(muted).child(
                    "Stop cancels this parent turn. Child tasks have separate cancellation.",
                ));
        }
        sidebar.into_any_element()
    }
}
