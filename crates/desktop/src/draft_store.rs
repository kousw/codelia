//! Background-only local storage. One current record per physical checkout; no draft logging.
use crate::{
    drafts::{DraftSnapshot, TOTAL_BYTES},
    transport::RuntimeOptions,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, SyncSender},
    thread::{self, JoinHandle},
};

const ERROR: &str = "Draft storage unavailable or changed; text is retained here. No prompt was sent. Inspect storage before retrying.";
const CONFLICT: &str = "Drafts changed in another app instance; local text is retained. Reopen and inspect before saving.";
const FILE_LIMIT: u64 = TOTAL_BYTES as u64 + 128 * 1024;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    root: String,
    project: String,
    checkout: String,
}
fn digest(text: &[u8]) -> String {
    Sha256::digest(text)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn identity(root: &Path) -> Result<Identity, &'static str> {
    let root = root.canonicalize().map_err(|_| ERROR)?;
    let meta = fs::metadata(&root).map_err(|_| ERROR)?;
    if !meta.is_dir() {
        return Err(ERROR);
    }
    let git = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(&root)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .map_err(|_| ERROR)?;
    let project = if git.status.success() {
        let common = PathBuf::from(String::from_utf8(git.stdout).map_err(|_| ERROR)?.trim())
            .canonicalize()
            .map_err(|_| ERROR)?;
        let cm = fs::metadata(&common).map_err(|_| ERROR)?;
        digest(format!("git:{}:{}:{}", common.display(), cm.dev(), cm.ino()).as_bytes())
    } else {
        // Only an ordinary non-Git folder is allowed to use folder identity.
        // If .git exists but is unreadable/broken, never silently rebind to a folder scope.
        for ancestor in root.ancestors() {
            match ancestor.join(".git").symlink_metadata() {
                Ok(_) => return Err(ERROR),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(ERROR),
            }
        }
        digest(format!("folder:{}:{}:{}", root.display(), meta.dev(), meta.ino()).as_bytes())
    };
    let checkout =
        digest(format!("{}:{}:{}:{project}", root.display(), meta.dev(), meta.ino()).as_bytes());
    Ok(Identity {
        root: root.to_string_lossy().into_owned(),
        project,
        checkout,
    })
}
fn state_root(options: &RuntimeOptions) -> Result<PathBuf, &'static str> {
    let value = |name: &str| {
        options
            .environment
            .get(name)
            .cloned()
            .or_else(|| std::env::var(name).ok())
    };
    let home = value("HOME").map(PathBuf::from).ok_or(ERROR)?;
    if value("CODELIA_LAYOUT").is_some_and(|v| v.eq_ignore_ascii_case("xdg")) {
        Ok(value("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/state"))
            .join("codelia"))
    } else {
        Ok(home.join(".codelia"))
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    identity: Identity,
    revision: u64,
    snapshot: DraftSnapshot,
}
pub struct Store {
    identity: Identity,
    dir: PathBuf,
}
impl Store {
    fn open(root: &Path, storage: &Path) -> Result<Self, &'static str> {
        let identity = identity(root)?;
        let dir = storage
            .join("desktop/drafts")
            .join(&identity.project)
            .join(&identity.checkout);
        Ok(Self { identity, dir })
    }
    fn check(&self) -> Result<(), &'static str> {
        if identity(Path::new(&self.identity.root))? != self.identity {
            Err(ERROR)
        } else {
            Ok(())
        }
    }
    fn read(&self) -> Result<(u64, DraftSnapshot), &'static str> {
        let current = self.dir.join("current.json");
        if let Ok(meta) = fs::symlink_metadata(&current)
            && (!meta.is_file() || meta.nlink() != 1)
        {
            return Err(ERROR);
        }
        let file = match File::open(&current) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((0, DraftSnapshot::default()));
            }
            Err(_) => return Err(ERROR),
        };
        let mut bytes = Vec::new();
        file.take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ERROR)?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(ERROR);
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
        if record.version != 1 || record.identity != self.identity || !record.snapshot.validate() {
            return Err(ERROR);
        }
        Ok((record.revision, record.snapshot))
    }
    fn load(&self) -> Result<(u64, DraftSnapshot), &'static str> {
        self.check()?;
        if !self.dir.try_exists().map_err(|_| ERROR)? {
            return Ok((0, DraftSnapshot::default()));
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(self.dir.join("writer.lock"))
            .map_err(|_| ERROR)?;
        lock.try_lock().map_err(|_| CONFLICT)?;
        let current = self.read()?;
        if let Ok(meta) = fs::symlink_metadata(self.dir.join("pending.json"))
            && meta.is_file()
            && meta.nlink() == 1
        {
            fs::remove_file(self.dir.join("pending.json")).map_err(|_| ERROR)?;
        }
        Ok(current)
    }
    fn save(&self, expected: u64, snapshot: DraftSnapshot) -> Result<u64, &'static str> {
        self.save_at(expected, snapshot, |_| Ok(()))
    }
    fn save_at(
        &self,
        expected: u64,
        snapshot: DraftSnapshot,
        boundary: impl FnOnce(&Path) -> Result<(), &'static str>,
    ) -> Result<u64, &'static str> {
        if !snapshot.validate() {
            return Err(ERROR);
        }
        self.check()?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .map_err(|_| ERROR)?;
        // OS advisory lock releases on process exit. No PID lease or stale-lock deletion.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(self.dir.join("writer.lock"))
            .map_err(|_| ERROR)?;
        lock.try_lock().map_err(|_| CONFLICT)?;
        let (revision, _) = self.read()?;
        if revision != expected {
            return Err(CONFLICT);
        }
        let revision = revision.checked_add(1).ok_or(ERROR)?;
        let bytes = serde_json::to_vec(&Record {
            version: 1,
            identity: self.identity.clone(),
            revision,
            snapshot,
        })
        .map_err(|_| ERROR)?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(ERROR);
        }
        let pending = self.dir.join("pending.json");
        if let Ok(meta) = fs::symlink_metadata(&pending) {
            if !meta.is_file() || meta.nlink() != 1 {
                return Err(ERROR);
            }
            fs::remove_file(&pending).map_err(|_| ERROR)?;
        }
        // Only the lock owner touches this bounded temporary replacement; no backup/history.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&pending)
            .map_err(|_| ERROR)?;
        file.write_all(&bytes).map_err(|_| ERROR)?;
        file.sync_all().map_err(|_| ERROR)?;
        boundary(&pending)?;
        self.check()?;
        fs::rename(&pending, self.dir.join("current.json")).map_err(|_| ERROR)?;
        File::open(&self.dir)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| ERROR)?;
        Ok(revision)
    }
}
pub enum Event {
    Loaded(Result<DraftSnapshot, &'static str>),
    Saved(u64, Result<(), &'static str>),
}
struct Save {
    seq: u64,
    snapshot: DraftSnapshot,
    merge_unseen: bool,
}
pub struct Worker {
    input: Option<SyncSender<Save>>,
    pub output: Receiver<Event>,
    handle: Option<JoinHandle<Result<(), &'static str>>>,
}
impl Worker {
    pub fn start(root: PathBuf, options: RuntimeOptions) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Save>(2);
        let (out, output) = mpsc::channel();
        let handle = thread::spawn(move || {
            let store = state_root(&options).and_then(|storage| Store::open(&root, &storage));
            let loaded = store
                .as_ref()
                .map_err(|error| *error)
                .and_then(|store| store.load());
            let mut revision = loaded.as_ref().map(|(r, _)| *r).unwrap_or(0);
            let mut failed = loaded.is_err();
            let initial = loaded
                .as_ref()
                .map(|(_, snapshot)| snapshot.clone())
                .unwrap_or_default();
            let _ = out.send(Event::Loaded(loaded.map(|(_, snapshot)| snapshot)));
            for mut save in rx {
                if save.merge_unseen {
                    if save.snapshot.drafts.is_empty() {
                        save.snapshot.selected = initial.selected.clone();
                    }
                    for (id, draft) in &initial.drafts {
                        save.snapshot
                            .drafts
                            .entry(id.clone())
                            .or_insert_with(|| draft.clone());
                    }
                }
                let result = if failed {
                    Err(ERROR)
                } else {
                    store
                        .as_ref()
                        .map_err(|error| *error)
                        .and_then(|store| store.save(revision, save.snapshot))
                        .map(|next| {
                            revision = next;
                        })
                };
                failed |= result.is_err();
                let _ = out.send(Event::Saved(save.seq, result));
                if save.seq == u64::MAX {
                    return result;
                }
            }
            if failed { Err(ERROR) } else { Ok(()) }
        });
        Self {
            input: Some(tx),
            output,
            handle: Some(handle),
        }
    }
    pub fn save(&self, seq: u64, snapshot: DraftSnapshot) -> Result<(), &'static str> {
        self.input
            .as_ref()
            .ok_or(ERROR)?
            .try_send(Save {
                seq,
                snapshot,
                merge_unseen: false,
            })
            .map_err(|_| ERROR)
    }
    pub fn stop(mut self) -> Option<JoinHandle<Result<(), &'static str>>> {
        self.input.take();
        self.handle.take()
    }
    pub fn finish(
        mut self,
        snapshot: DraftSnapshot,
        merge_unseen: bool,
    ) -> Option<JoinHandle<Result<(), &'static str>>> {
        let _ = self.input.as_ref().and_then(|input| {
            input
                .try_send(Save {
                    seq: u64::MAX,
                    snapshot,
                    merge_unseen,
                })
                .ok()
        });
        self.input.take();
        self.handle.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        draft_controller::{Action, Controller},
        drafts::DraftText,
        state::State,
    };
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        storage: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir()
                .join(format!("codelia-native-drafts-{}", uuid::Uuid::new_v4()));
            let root = base.join("workspace");
            fs::create_dir_all(&root).unwrap();
            Self {
                storage: base.join("state/codelia"),
                base,
                root,
            }
        }
        fn options(&self) -> RuntimeOptions {
            let mut options = RuntimeOptions::for_entry(PathBuf::new());
            options
                .environment
                .insert("CODELIA_LAYOUT".into(), "xdg".into());
            options.environment.insert(
                "XDG_STATE_HOME".into(),
                self.base.join("state").to_string_lossy().into_owned(),
            );
            options
        }
        fn store(&self) -> Store {
            Store::open(&self.root, &self.storage).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn snapshot(id: &str, text: &str) -> DraftSnapshot {
        DraftSnapshot {
            selected: id.into(),
            drafts: [(
                id.into(),
                DraftText {
                    text: text.into(),
                    title: "Draft".into(),
                },
            )]
            .into(),
        }
    }
    fn wait(controller: &mut Controller, state: &mut State, predicate: impl Fn(&State) -> bool) {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !predicate(state) && std::time::Instant::now() < until {
            controller.poll(state);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(predicate(state), "bounded draft worker completion");
    }
    fn ready(f: &Fixture, state: &mut State) -> Controller {
        let mut controller = Controller::start(f.root.clone(), f.options());
        wait(&mut controller, state, |state| {
            state.draft_notice.as_deref() == Some("Drafts recovered")
        });
        controller
    }
    #[test]
    fn restart_keeps_only_current_thread_drafts_and_physical_scope() {
        let f = Fixture::new();
        let store = f.store();
        let data = DraftSnapshot {
            selected: "session-one".into(),
            drafts: [
                (
                    "session-one".into(),
                    DraftText {
                        text: "日本語 未送信".into(),
                        title: "One".into(),
                    },
                ),
                (
                    "draft-two".into(),
                    DraftText {
                        text: "second unsent".into(),
                        title: "Two".into(),
                    },
                ),
            ]
            .into(),
        };
        assert!(store.save(0, data.clone()).is_ok());
        let (_, loaded) = f.store().load().unwrap();
        assert!(loaded == data);
        let other = f.base.join("other");
        fs::create_dir(&other).unwrap();
        assert!(
            Store::open(&other, &f.storage)
                .unwrap()
                .load()
                .unwrap()
                .1
                .drafts
                .is_empty()
        );
        let alias = f.base.join("alias");
        std::os::unix::fs::symlink(&f.root, &alias).unwrap();
        assert!(Store::open(&alias, &f.storage).unwrap().load().unwrap().1 == data);
        let mut state = State::default();
        assert!(loaded.restore(&mut state));
        assert!(state.key() == "session-one");
        assert!(state.conversation().transcript_evicted);
        assert!(!state.busy && !state.loading && !state.has_pending("run.start"));
        let cleared = DraftSnapshot {
            selected: "session-one".into(),
            ..Default::default()
        };
        assert!(store.save(1, cleared).is_ok());
        assert!(f.store().load().unwrap().1.drafts.is_empty());
        assert!(
            fs::read_dir(&store.dir).unwrap().count() == 2,
            "current JSON and zero-content lock only"
        );
        fs::rename(&f.root, f.base.join("saved-workspace")).unwrap();
        fs::create_dir(&f.root).unwrap();
        assert!(
            store
                .save(2, snapshot("session-one", "must not leak"))
                .is_err()
        );
        assert!(f.store().load().unwrap().1.drafts.is_empty());
    }
    #[test]
    fn stale_writer_corruption_and_write_failure_never_replace_current() {
        let f = Fixture::new();
        let first = f.store();
        let second = f.store();
        let old = snapshot("draft-a", "private draft sentinel");
        assert!(first.save(0, old.clone()).is_ok());
        let old_bytes = fs::read(first.dir.join("current.json")).unwrap();
        assert!(second.save(0, snapshot("draft-b", "stale")).is_err());
        assert!(fs::read(first.dir.join("current.json")).unwrap() == old_bytes);
        fs::create_dir(first.dir.join("pending.json")).unwrap();
        let error = first
            .save(1, snapshot("draft-a", "replacement sentinel"))
            .unwrap_err();
        assert!(!error.contains("sentinel") && !error.contains("private"));
        assert!(first.load().unwrap().1 == old);
        fs::remove_dir(first.dir.join("pending.json")).unwrap();
        fs::write(first.dir.join("current.json"), b"{\"version\":1,").unwrap();
        assert!(first.load().is_err());
        assert!(first.save(1, old).is_err());
        assert!(fs::read(first.dir.join("current.json")).unwrap() == b"{\"version\":1,");
        fs::write(
            first.dir.join("current.json"),
            vec![b' '; FILE_LIMIT as usize + 1],
        )
        .unwrap();
        assert!(first.load().is_err());
    }
    #[test]
    fn interrupted_writer_child() {
        let Some(root) = std::env::var_os("CODELIA_DRAFT_TEST_ROOT") else {
            return;
        };
        let storage = PathBuf::from(std::env::var_os("CODELIA_DRAFT_TEST_STORAGE").unwrap());
        let store = Store::open(&PathBuf::from(root), &storage).unwrap();
        let revision = store.load().unwrap().0;
        if std::env::var_os("CODELIA_DRAFT_TEST_AFTER_COMMIT").is_some() {
            assert!(store.save(revision, DraftSnapshot::default()).is_ok());
            std::process::exit(23);
        }
        let _ = store.save_at(
            revision,
            snapshot("draft-crashed", "uncommitted text"),
            |_| std::process::exit(23),
        );
        panic!("test-only process exit boundary was not reached");
    }
    #[test]
    fn abrupt_exit_after_fsync_before_rename_retains_old_commit_and_releases_lock() {
        let f = Fixture::new();
        let store = f.store();
        let data = snapshot("draft-old", "committed Japanese 日本語");
        assert!(store.save(0, data.clone()).is_ok());
        let exit = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "draft_store::tests::interrupted_writer_child",
                "--nocapture",
            ])
            .env("CODELIA_DRAFT_TEST_ROOT", &f.root)
            .env("CODELIA_DRAFT_TEST_STORAGE", &f.storage)
            .output()
            .unwrap();
        assert!(exit.status.code() == Some(23));
        assert!(
            f.store().load().unwrap().1 == data,
            "uncommitted pending file is never restored or replayed"
        );
        assert!(store.save(1, DraftSnapshot::default()).is_ok());
        assert!(f.store().load().unwrap().1.drafts.is_empty());
        assert!(!store.dir.join("pending.json").exists());
        assert!(store.save(2, data).is_ok());
        let committed = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "draft_store::tests::interrupted_writer_child"])
            .env("CODELIA_DRAFT_TEST_ROOT", &f.root)
            .env("CODELIA_DRAFT_TEST_STORAGE", &f.storage)
            .env("CODELIA_DRAFT_TEST_AFTER_COMMIT", "1")
            .output()
            .unwrap();
        assert!(committed.status.code() == Some(23));
        assert!(
            f.store().load().unwrap().1.drafts.is_empty(),
            "committed clear cannot resurrect text after abrupt exit"
        );
    }
    #[test]
    fn background_quit_flush_and_startup_typing_are_isolated_without_execution() {
        let f = Fixture::new();
        let mut state = State::default();
        state.draft_key = "draft-old".into();
        let controller = ready(&f, &mut state);
        state.set_draft("未送信の依頼".into());
        assert!(controller.finish(&state).unwrap().join().unwrap().is_ok());
        let mut restart = State::default();
        restart.draft_key = "draft-new-unique".into();
        restart.set_draft("typed during recovery".into());
        let controller = ready(&f, &mut restart);
        assert!(restart.key() == "draft-new-unique");
        assert!(restart.conversations["draft-old"].draft == "未送信の依頼");
        assert!(restart.conversation().draft == "typed during recovery");
        assert!(!restart.has_pending("run.start"));
        assert!(controller.finish(&restart).unwrap().join().unwrap().is_ok());
        assert!(f.store().load().unwrap().1.drafts.len() == 2);
    }
    #[test]
    fn send_and_explicit_clear_require_durable_removal_and_failed_send_keeps_input() {
        let f = Fixture::new();
        let mut state = State::default();
        state.connected = true;
        state.model_available = true;
        state.supports_new_session = true;
        let mut controller = ready(&f, &mut state);
        state.set_draft("send this once".into());
        controller
            .stage(&mut state, Action::Send("send this once".into()))
            .unwrap();
        let mut sends = 0;
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while state.loading && std::time::Instant::now() < until {
            let update = controller.poll(&mut state);
            if update.send.is_some() {
                assert!(f.store().load().unwrap().1.drafts.is_empty());
                sends += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(sends == 1 && !state.loading && state.conversation().draft.is_empty());
        state.set_draft("explicit clear".into());
        controller.stage(&mut state, Action::Clear).unwrap();
        wait(&mut controller, &mut state, |s| !s.loading);
        assert!(f.store().load().unwrap().1.drafts.is_empty());
        state.set_draft("failed draft remains".into());
        fs::create_dir(f.store().dir.join("pending.json")).unwrap();
        controller
            .stage(&mut state, Action::Send("failed draft remains".into()))
            .unwrap();
        wait(&mut controller, &mut state, |s| !s.loading);
        assert!(state.conversation().draft == "failed draft remains");
        assert!(!state.has_pending("run.start"));
        assert!(controller.poll(&mut state).send.is_none());
        assert!(controller.finish(&state).unwrap().join().unwrap().is_err());
    }
    #[test]
    fn close_before_recovery_completes_merges_unseen_saved_drafts() {
        let f = Fixture::new();
        assert!(
            f.store()
                .save(0, snapshot("draft-old", "previous saved"))
                .is_ok()
        );
        let mut state = State::default();
        state.draft_key = "draft-new".into();
        state.set_draft("new unsent".into());
        let controller = Controller::start(f.root.clone(), f.options());
        assert!(controller.finish(&state).unwrap().join().unwrap().is_ok());
        let loaded = f.store().load().unwrap().1;
        assert!(
            loaded.drafts.len() == 2
                && loaded.drafts["draft-old"].text == "previous saved"
                && loaded.drafts["draft-new"].text == "new unsent"
        );
    }
    #[test]
    fn input_saves_coalesce_and_explicit_flush_commits_only_latest_data() {
        let f = Fixture::new();
        let mut state = State::default();
        let mut controller = ready(&f, &mut state);
        for n in 0..100 {
            state.set_draft(format!("latest-{n}"));
            let _ = controller.poll(&mut state);
        }
        assert!(
            f.store().load().unwrap().0 == 0,
            "no file I/O per keystroke"
        );
        controller.request_flush(&mut state);
        wait(&mut controller, &mut state, |s| {
            s.draft_notice.as_deref() == Some("Draft saved")
        });
        let (revision, loaded) = f.store().load().unwrap();
        assert!(revision == 1 && loaded.drafts.values().any(|d| d.text == "latest-99"));
        assert!(controller.flushed(&state));
        assert!(controller.stop().unwrap().join().unwrap().is_ok());
    }
    #[test]
    fn oversize_flush_is_blocked_without_copying_body_and_editing_can_recover() {
        let f = Fixture::new();
        let mut state = State::default();
        let mut controller = ready(&f, &mut state);
        state.set_draft("x".repeat(crate::drafts::DRAFT_BYTES + 1));
        controller.request_flush(&mut state);
        let _ = controller.poll(&mut state);
        assert!(controller.failed() && !controller.flushed(&state));
        assert!(f.store().load().unwrap().0 == 0);
        state.set_draft("shorter Japanese 日本語".into());
        controller.request_flush(&mut state);
        wait(&mut controller, &mut state, |s| {
            s.draft_notice.as_deref() == Some("Draft saved")
        });
        assert!(!controller.failed() && controller.flushed(&state));
        assert!(controller.stop().unwrap().join().unwrap().is_ok());
    }
    #[test]
    fn cancelled_send_ack_cannot_release_another_threads_repeated_send() {
        let f = Fixture::new();
        let mut data = snapshot("draft-first", "first draft");
        data.drafts.insert(
            "draft-second".into(),
            crate::drafts::DraftText {
                text: "second draft".into(),
                title: "Second".into(),
            },
        );
        assert!(f.store().save(0, data).is_ok());
        let mut state = State::default();
        let mut controller = ready(&f, &mut state);
        controller
            .stage(&mut state, Action::Send("first draft".into()))
            .unwrap();
        let _ = controller.poll(&mut state);
        controller.request_flush(&mut state);
        assert!(!state.draft_send_pending);
        assert!(state.select_cached("draft-second"));
        controller
            .stage(&mut state, Action::Send("second draft".into()))
            .unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut delivered = false;
        while state.loading && std::time::Instant::now() < until {
            let update = controller.poll(&mut state);
            if let Some(text) = update.send {
                let disk = f.store().load().unwrap().1;
                assert!(
                    text == "second draft"
                        && !disk.drafts.contains_key("draft-second")
                        && disk.drafts["draft-first"].text == "first draft"
                );
                delivered = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(delivered);
        assert!(controller.stop().unwrap().join().unwrap().is_ok());
    }
    #[test]
    fn continuous_typing_is_periodically_saved_before_any_idle_pause() {
        let f = Fixture::new();
        let mut state = State::default();
        let mut controller = ready(&f, &mut state);
        let until = std::time::Instant::now() + std::time::Duration::from_millis(2250);
        let mut n = 0;
        while std::time::Instant::now() < until {
            state.set_draft(format!("continuous-{n}"));
            n += 1;
            let _ = controller.poll(&mut state);
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        let (revision, disk) = f.store().load().unwrap();
        assert!(revision > 0 && !disk.drafts.is_empty());
        assert!(controller.finish(&state).unwrap().join().unwrap().is_ok());
    }
    #[test]
    fn quitting_while_send_is_staged_preserves_unsent_text_without_dispatch() {
        let f = Fixture::new();
        let mut state = State::default();
        state.connected = true;
        state.model_available = true;
        let mut controller = ready(&f, &mut state);
        state.set_draft("cancelled before admission".into());
        controller
            .stage(
                &mut state,
                Action::Send("cancelled before admission".into()),
            )
            .unwrap();
        let _ = controller.poll(&mut state);
        assert!(controller.finish(&state).unwrap().join().unwrap().is_ok());
        assert!(
            f.store()
                .load()
                .unwrap()
                .1
                .drafts
                .values()
                .any(|d| d.text == "cancelled before admission")
        );
        assert!(!state.has_pending("run.start"));
    }
}

#[cfg(test)]
pub(crate) fn seed_test_draft(root: &Path, storage: &Path, snapshot: DraftSnapshot) -> PathBuf {
    let dir = Store::open(root, storage).unwrap().dir;
    assert!(
        Store::open(root, storage)
            .unwrap()
            .save(0, snapshot)
            .is_ok()
    );
    dir
}

#[cfg(test)]
mod git_identity_tests {
    use super::*;
    #[test]
    fn linked_worktree_shares_project_but_cannot_read_sibling_drafts_or_replaced_checkout() {
        let base = std::env::temp_dir().join(format!("codelia-draft-git-{}", uuid::Uuid::new_v4()));
        let first = base.join("first");
        let second = base.join("second");
        fs::create_dir_all(&first).unwrap();
        let git = |root: &Path, args: &[&str]| {
            let result = Command::new("git")
                .args([
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                    "-C",
                ])
                .arg(root)
                .args(args)
                .output()
                .unwrap();
            assert!(result.status.success());
        };
        git(&first, &["init", "-b", "main"]);
        fs::write(first.join("README.md"), "test-only fixture\n").unwrap();
        git(&first, &["add", "README.md"]);
        git(
            &first,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        );
        git(
            &first,
            &["worktree", "add", "-b", "second", second.to_str().unwrap()],
        );
        let store = Store::open(&first, &base.join("state")).unwrap();
        let sibling = Store::open(&second, &base.join("state")).unwrap();
        assert!(
            store.identity.project == sibling.identity.project
                && store.identity.checkout != sibling.identity.checkout
        );
        let snapshot = DraftSnapshot {
            selected: "session-one".into(),
            drafts: [(
                "session-one".into(),
                crate::drafts::DraftText {
                    text: "workspace-one only".into(),
                    title: "One".into(),
                },
            )]
            .into(),
        };
        assert!(store.save(0, snapshot).is_ok());
        assert!(sibling.load().unwrap().1.drafts.is_empty());
        fs::create_dir_all(&sibling.dir).unwrap();
        fs::copy(
            store.dir.join("current.json"),
            sibling.dir.join("current.json"),
        )
        .unwrap();
        assert!(
            sibling.load().is_err(),
            "foreign scope record must not be materialized"
        );
        fs::rename(&second, base.join("second-saved")).unwrap();
        fs::create_dir(&second).unwrap();
        assert!(sibling.load().is_err());
        assert!(
            Store::open(&second, &base.join("state"))
                .unwrap()
                .load()
                .unwrap()
                .1
                .drafts
                .is_empty()
        );
        fs::remove_dir_all(base).unwrap();
    }
}
