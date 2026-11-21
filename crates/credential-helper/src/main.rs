#[cfg(target_os = "macos")]
mod darwin;

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Probe,
    Get {
        service: String,
        account: String,
    },
    Set {
        service: String,
        account: String,
        value: String,
    },
    Delete {
        service: String,
        account: String,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Response {
    ProbeOk {
        ok: bool,
        status: String,
    },
    GetOk {
        ok: bool,
        found: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    SetOk {
        ok: bool,
    },
    DeleteOk {
        ok: bool,
        deleted: bool,
    },
    Err {
        ok: bool,
        code: String,
        message: String,
    },
}

impl Response {
    pub fn err(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            code: code.into(),
            message: message.into(),
        }
    }
}

fn validate_identifier(name: &str, label: &str) -> Result<(), Response> {
    if name.is_empty() || name.len() > 256 || name.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(Response::err(
            "invalid_request",
            format!("invalid {label}"),
        ));
    }
    Ok(())
}

fn handle_request(request: Request) -> Response {
    match &request {
        Request::Probe => {}
        Request::Get { service, account } | Request::Delete { service, account } => {
            if let Err(err) = validate_identifier(service, "service") {
                return err;
            }
            if let Err(err) = validate_identifier(account, "account") {
                return err;
            }
        }
        Request::Set {
            service, account, ..
        } => {
            if let Err(err) = validate_identifier(service, "service") {
                return err;
            }
            if let Err(err) = validate_identifier(account, "account") {
                return err;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        darwin::execute(request)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Response::err("unavailable", "unsupported_platform")
    }
}

fn main() {
    let mut input = String::new();
    let mut limited = io::stdin().take(MAX_REQUEST_BYTES + 1);
    if let Err(error) = limited.read_to_string(&mut input) {
        write_response(&Response::err(
            "invalid_request",
            format!("failed to read stdin: {error}"),
        ));
        std::process::exit(1);
    }
    if (input.len() as u64) > MAX_REQUEST_BYTES {
        write_response(&Response::err("invalid_request", "request exceeds size limit"));
        std::process::exit(1);
    }
    let request: Request = match serde_json::from_str(&input) {
        Ok(req) => req,
        Err(error) => {
            write_response(&Response::err(
                "invalid_request",
                format!("invalid JSON request: {error}"),
            ));
            std::process::exit(1);
        }
    };
    let response = handle_request(request);
    write_response(&response);
}

fn write_response(response: &Response) {
    let serialized = serde_json::to_string(response).unwrap_or_else(|_| {
        r#"{"ok":false,"code":"error","message":"failed to serialize response"}"#.to_string()
    });
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(serialized.as_bytes());
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_and_crud_requests() {
        let probe: Request = serde_json::from_str(r#"{"op":"probe"}"#).unwrap();
        assert!(matches!(probe, Request::Probe));

        let set: Request = serde_json::from_str(
            r#"{"op":"set","service":"codelia.auth","account":"codelia-abc","value":"{\"version\":2}"}"#,
        )
        .unwrap();
        assert!(matches!(set, Request::Set { .. }));
    }

    #[test]
    fn rejects_empty_or_control_char_identifiers() {
        let resp = handle_request(Request::Get {
            service: "".to_string(),
            account: "codelia-abc".to_string(),
        });
        assert_eq!(
            resp,
            Response::Err {
                ok: false,
                code: "invalid_request".to_string(),
                message: "invalid service".to_string(),
            }
        );

        let resp2 = handle_request(Request::Delete {
            service: "codelia.auth".to_string(),
            account: "bad\naccount".to_string(),
        });
        assert_eq!(
            resp2,
            Response::Err {
                ok: false,
                code: "invalid_request".to_string(),
                message: "invalid account".to_string(),
            }
        );
    }
}
