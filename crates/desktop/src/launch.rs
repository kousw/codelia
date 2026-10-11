//! Platform launch settings. QA configuration never alters the process environment.
use crate::transport::RuntimeOptions;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationConfig {
    version: u8,
    fixture_root: PathBuf,
    provider_base_url: String,
}

pub struct Launch {
    pub root: PathBuf,
    pub runtime: RuntimeOptions,
}

fn fixture(config: ValidationConfig, runtime: RuntimeOptions) -> Result<Launch> {
    if config.version != 1 {
        bail!("Unsupported native validation config version");
    }
    let root = config.fixture_root;
    let temp = std::env::temp_dir();
    let allowed = [Path::new("/tmp"), Path::new("/private/tmp"), temp.as_path()];
    if !root.is_absolute()
        || root.components().any(|c| matches!(c, Component::ParentDir))
        || !allowed.iter().any(|p| root.starts_with(p) && root != *p)
    {
        bail!("Native validation fixture must be a dedicated absolute temporary directory");
    }
    let port = config
        .provider_base_url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|url| url.strip_suffix("/v1"))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0);
    if port.is_none() {
        bail!("Native validation provider must be http://127.0.0.1:<port>/v1");
    }
    let environment = BTreeMap::from([
        ("OPENAI_API_KEY".into(), "fixture-not-a-secret".into()),
        ("OPENAI_BASE_URL".into(), config.provider_base_url),
        ("CODELIA_LAYOUT".into(), "xdg".into()),
        (
            "XDG_CONFIG_HOME".into(),
            root.join("config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CACHE_HOME".into(),
            root.join("cache").to_string_lossy().into_owned(),
        ),
        (
            "XDG_STATE_HOME".into(),
            root.join("state").to_string_lossy().into_owned(),
        ),
    ]);
    Ok(Launch {
        root: root.join("workspace"),
        runtime: RuntimeOptions {
            environment,
            stderr_log: Some(root.join("native-runtime-stderr.log")),
            ..runtime
        },
    })
}

pub fn resolve(workspace: Option<OsString>, executable: &Path) -> Result<Launch> {
    let entry = std::env::var_os("CODELIA_DESKTOP_RUNTIME_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/runtime/src/index.ts")
        });
    let runtime = RuntimeOptions::for_entry(entry);
    let resource = executable
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "MacOS"))
        .and_then(Path::parent)
        .map(|contents| contents.join("Resources/codelia-validation.json"));
    if let Some(resource) = resource {
        match std::fs::metadata(&resource) {
            Ok(meta) => {
                if !meta.is_file() || meta.len() > 8192 {
                    bail!("Invalid native validation config size");
                }
                let mut bytes = Vec::new();
                std::fs::File::open(&resource)
                    .context("Read native validation config")?
                    .take(8193)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 8192 {
                    bail!("Invalid native validation config size");
                }
                let config: ValidationConfig = serde_json::from_slice(&bytes)
                    .context("Invalid native validation config; runtime was not started")?;
                let launch = fixture(config, runtime)?;
                let physical_root = launch
                    .root
                    .parent()
                    .unwrap()
                    .canonicalize()
                    .context("Validation fixture directory must exist")?;
                let temp = std::env::temp_dir();
                if ![Path::new("/tmp"), Path::new("/private/tmp"), temp.as_path()]
                    .iter()
                    .any(|p| physical_root.starts_with(p) && physical_root != *p)
                {
                    bail!("Validation fixture cannot resolve outside temporary directories");
                }
                return Ok(launch);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Read native validation config metadata"),
        }
    }
    Ok(Launch {
        root: workspace
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        runtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn config(root: &str, url: &str) -> ValidationConfig {
        serde_json::from_value(json!({"version":1,"fixture_root":root,"provider_base_url":url}))
            .unwrap()
    }
    #[test]
    fn validation_is_loopback_only_and_keeps_the_original_runtime_source() {
        let entry = PathBuf::from("/same/checkout/packages/runtime/src/index.ts");
        let launch = fixture(
            config("/tmp/codelia-fixture", "http://127.0.0.1:64405/v1"),
            RuntimeOptions::for_entry(entry.clone()),
        )
        .unwrap();
        assert_eq!(launch.runtime.entry, entry);
        assert_eq!(launch.root, Path::new("/tmp/codelia-fixture/workspace"));
        assert_eq!(
            launch.runtime.environment["OPENAI_API_KEY"],
            "fixture-not-a-secret"
        );
        assert_eq!(
            launch.runtime.environment["XDG_CONFIG_HOME"],
            "/tmp/codelia-fixture/config"
        );
        for (root, url) in [
            ("/Users/someone/Documents", "http://127.0.0.1:1/v1"),
            ("/tmp/../Users/someone", "http://127.0.0.1:1/v1"),
            ("/tmp", "http://127.0.0.1:1/v1"),
            ("/tmp/codelia-fixture", "https://api.openai.com/v1"),
            ("/tmp/codelia-fixture", "http://127.0.0.1:0/v1"),
            (
                "/tmp/codelia-fixture",
                "http://127.0.0.1:1/v1?redirect=remote",
            ),
        ] {
            assert!(fixture(config(root, url), RuntimeOptions::for_entry(PathBuf::new())).is_err());
        }
    }
    #[test]
    fn invalid_validation_config_cannot_fall_back_to_normal_credentials() {
        let root = std::env::temp_dir().join(format!("codelia-launch-test-{}", std::process::id()));
        let resource = root.join("Example.app/Contents/Resources");
        std::fs::create_dir_all(&resource).unwrap();
        let executable = root.join("Example.app/Contents/MacOS/codelia-desktop");
        let config_path = resource.join("codelia-validation.json");
        std::fs::write(&config_path, b"invalid").unwrap();
        assert!(resolve(None, &executable).is_err());
        std::fs::write(&config_path, vec![b' '; 8193]).unwrap();
        assert!(resolve(None, &executable).is_err());
        let alias = root.join("protected-alias");
        std::os::unix::fs::symlink("/Users", &alias).unwrap();
        std::fs::write(
            &config_path,
            serde_json::to_vec(&json!({
                "version":1,"fixture_root":alias,"provider_base_url":"http://127.0.0.1:64405/v1"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(resolve(None, &executable).is_err());
        std::fs::remove_file(&config_path).unwrap();
        let ordinary = resolve(Some(OsString::from("/chosen/workspace")), &executable).unwrap();
        assert_eq!(ordinary.root, Path::new("/chosen/workspace"));
        assert!(ordinary.runtime.environment.is_empty());
        assert!(ordinary.runtime.stderr_log.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
