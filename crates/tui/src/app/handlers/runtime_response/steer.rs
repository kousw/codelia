use crate::app::state::{LogKind, LogLine};
use crate::app::{AppState, InFlightSteer, PROMPT_DISPATCH_MAX_ATTEMPTS};
use std::collections::{HashSet, VecDeque};

fn confirmed_steer_position(
    steers: &VecDeque<InFlightSteer>,
    run_scope: Option<&str>,
    steer_id: &str,
) -> Option<usize> {
    steers.iter().position(|steer| {
        run_scope.is_none_or(|scope| steer.run_id == scope)
            && steer.server_steer_id.as_deref() == Some(steer_id)
    })
}

fn unverified_steer_positions<'a>(
    steers: &'a VecDeque<InFlightSteer>,
    run_id: &'a str,
    steer_id: &'a str,
) -> impl Iterator<Item = (usize, &'a InFlightSteer)> {
    steers.iter().enumerate().filter(move |(_, steer)| {
        steer.run_id == run_id && steer.unverified_steer_id.as_deref() == Some(steer_id)
    })
}

fn pause_steer(steer: &mut InFlightSteer) {
    steer.submission.dispatch_attempts = PROMPT_DISPATCH_MAX_ATTEMPTS;
}

/// The in-flight steer a `steer_applied` refers to. A supplied client id must
/// agree with any confirmed server ids. Without a client id, a confirmed id
/// wins, followed by a unique unverified id. Conflicting candidates stay paused.
pub(super) fn applied_steer_position(
    app: &mut AppState,
    run_id: &str,
    steer_id: &str,
    client_id: Option<&str>,
) -> Option<usize> {
    if let Some(client_id) = client_id {
        let client_index = app
            .in_flight_steers
            .iter()
            .position(|steer| steer.run_id == run_id && steer.client_steer_id == client_id);
        if let Some(index) = client_index {
            let steer = &app.in_flight_steers[index];
            let confirmed_id_agrees = steer
                .server_steer_id
                .as_deref()
                .is_none_or(|id| id == steer_id);
            let confirmed_elsewhere =
                app.in_flight_steers
                    .iter()
                    .enumerate()
                    .any(|(other, steer)| {
                        other != index
                            && steer.run_id == run_id
                            && steer.server_steer_id.as_deref() == Some(steer_id)
                    });
            if confirmed_id_agrees && !confirmed_elsewhere {
                return Some(index);
            }
        }
        for (index, steer) in app.in_flight_steers.iter_mut().enumerate() {
            if steer.run_id == run_id
                && (client_index == Some(index)
                    || steer.server_steer_id.as_deref() == Some(steer_id)
                    || steer.unverified_steer_id.as_deref() == Some(steer_id))
            {
                pause_steer(steer);
            }
        }
        app.push_line(
            LogKind::Error,
            format!("Steer {steer_id}: applied notification has inconsistent client and server IDs; matching pending steers will not be resent automatically."),
        );
        return None;
    }
    if let Some(index) = confirmed_steer_position(&app.in_flight_steers, Some(run_id), steer_id) {
        return Some(index);
    }
    let unverified: Vec<_> = unverified_steer_positions(&app.in_flight_steers, run_id, steer_id)
        .map(|(index, _)| index)
        .collect();
    if let [only] = unverified.as_slice() {
        return Some(*only);
    }
    if !unverified.is_empty() {
        for index in unverified {
            pause_steer(&mut app.in_flight_steers[index]);
        }
        app.push_line(
            LogKind::Error,
            format!("Steer {steer_id} was applied, but several pending steers carry that id; they will not be resent automatically."),
        );
    }
    None
}

fn unconsumed_steer_positions(
    steers: &VecDeque<InFlightSteer>,
    finished_run_scope: Option<&str>,
    server_ids: &[String],
    client_ids: Option<&[String]>,
) -> HashSet<usize> {
    if let Some(client_ids) = client_ids {
        return steers
            .iter()
            .enumerate()
            .filter_map(|(index, steer)| {
                (finished_run_scope == Some(steer.run_id.as_str())
                    && client_ids.contains(&steer.client_steer_id))
                .then_some(index)
            })
            .collect();
    }

    server_ids
        .iter()
        .filter_map(|id| {
            if let Some(index) = confirmed_steer_position(steers, finished_run_scope, id) {
                return Some(index);
            }
            let mut unverified = unverified_steer_positions(steers, finished_run_scope?, id)
                .filter(|(_, steer)| steer.server_steer_id.is_none());
            let (index, _) = unverified.next()?;
            unverified.next().is_none().then_some(index)
        })
        .collect()
}

pub(super) fn pause_unreadable_run_steers(app: &mut AppState, run_id: Option<&str>) {
    let Some(run_id) = run_id.or(app.runtime_info.active_run_id.as_deref()) else {
        return;
    };
    // An applied steer may be among these. Keep them paused unless the
    // runtime explicitly lists them as unconsumed.
    let mut pending = app
        .in_flight_steers
        .iter_mut()
        .filter(|steer| steer.run_id == run_id);
    let Some(first) = pending.next() else {
        return;
    };
    pause_steer(first);
    pending.for_each(pause_steer);
    app.push_line(
        LogKind::Error,
        "A steer_applied notification could not be read; pending steers of this run will not be resent automatically.",
    );
}

pub(super) fn fallback_unconsumed_steers(
    app: &mut AppState,
    finished_run_scope: Option<&str>,
    unconsumed_steer_ids: &[String],
    unconsumed_client_steer_ids: Option<&[String]>,
) {
    if app.in_flight_steers.is_empty() {
        return;
    }
    let matched = unconsumed_steer_positions(
        &app.in_flight_steers,
        finished_run_scope,
        unconsumed_steer_ids,
        unconsumed_client_steer_ids,
    );

    let mut kept = VecDeque::with_capacity(app.in_flight_steers.len());
    let mut fallen_back = Vec::new();
    for (index, steer) in app.in_flight_steers.drain(..).enumerate() {
        let matches_unconsumed_id = matched.contains(&index);
        let matches_finished_run = finished_run_scope.is_some_and(|scope| steer.run_id == scope);
        if matches_unconsumed_id || matches_finished_run {
            let mut steer = steer;
            // The runtime listed it as unconsumed, so it was not applied and
            // may be dispatched again even if its result was unverified.
            if matches_unconsumed_id
                && steer.submission.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS
            {
                steer.submission.dispatch_attempts = 0;
            }
            fallen_back.push(steer);
        } else {
            kept.push_back(steer);
        }
    }
    app.in_flight_steers = kept;

    for mut steer in fallen_back {
        let steer_label = steer
            .server_steer_id
            .clone()
            .unwrap_or_else(|| steer.client_steer_id.clone());
        if steer.submission.queue_id.is_empty() {
            steer.submission.queue_id = app.allocate_prompt_queue_id();
        }
        let queue_id = steer.submission.queue_id.clone();
        let paused = steer.submission.dispatch_attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS;
        crate::app::handlers::command::insert_pending_prompt_ordered(
            &mut app.pending_prompt_queue,
            steer.submission,
        );
        if paused {
            app.push_line(
                LogKind::Error,
                format!(
                    "Paused steer {queue_id}: it may already have been applied. Use /queue retry or /queue cancel."
                ),
            );
        } else {
            app.push_line(
                LogKind::Status,
                format!(
                    "Steer {steer_label} was not picked up before run ended; moved to queue ({queue_id}, queue={})",
                    app.pending_prompt_queue.len()
                ),
            );
        }
    }
}

pub(super) fn apply_steer(
    app: &mut AppState,
    run_id: &str,
    steer_id: &str,
    client_id: Option<&str>,
) -> Option<Vec<LogLine>> {
    let index = applied_steer_position(app, run_id, steer_id, client_id)?;
    let steer = app.in_flight_steers.remove(index)?;
    Some(crate::app::state::log::user_message_lines(
        &steer.submission.display_text,
        &steer.submission.image_descriptions,
    ))
}
