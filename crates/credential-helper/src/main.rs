#[cfg(all(target_os = "macos", not(test)))]
mod darwin;
#[cfg(any(target_os = "macos", test))]
mod keychain_policy;

use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use std::io::{self, Read, Write};

#[cfg(not(test))]
const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Probe,
    Get {
        service: String,
        account: String,
    },
    Authorize {
        service: String,
        account: String,
        #[serde(default)]
        allow_prompt: bool,
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

impl Request {
    #[cfg(any(target_os = "macos", test))]
    fn allows_prompt(&self) -> bool {
        matches!(
            self,
            Self::Authorize {
                allow_prompt: true,
                ..
            }
        )
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
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
    AuthorizeOk {
        ok: bool,
        found: bool,
        authorized: bool,
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
        return Err(Response::err("invalid_request", format!("invalid {label}")));
    }
    Ok(())
}

fn handle_request(request: Request, execute: impl FnOnce(Request) -> Response) -> Response {
    if let Request::Authorize {
        service, account, ..
    } = &request
    {
        let valid_account = account.strip_prefix("codelia-").is_some_and(|digest| {
            digest.len() == 16
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if !matches!(service.as_str(), "codelia.auth" | "codelia.mcp-auth") || !valid_account {
            return Response::err("invalid_request", "authorization requires a Codelia item");
        }
    }
    match &request {
        Request::Probe => {}
        Request::Get { service, account }
        | Request::Authorize {
            service, account, ..
        }
        | Request::Delete { service, account }
        | Request::Set {
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

    execute(request)
}

fn parse_request(input: &str) -> Result<Request, Response> {
    // A deserialization error can contain input data, including a password.
    serde_json::from_str(input)
        .map_err(|_| Response::err("invalid_request", "invalid JSON request"))
}

#[cfg(not(test))]
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
        write_response(&Response::err(
            "invalid_request",
            "request exceeds size limit",
        ));
        std::process::exit(1);
    }
    let request = match parse_request(&input) {
        Ok(req) => req,
        Err(error) => {
            write_response(&error);
            std::process::exit(1);
        }
    };
    #[cfg(target_os = "macos")]
    let response = handle_request(request, darwin::execute);
    #[cfg(not(target_os = "macos"))]
    let response = handle_request(request, |_| {
        Response::err("unavailable", "unsupported_platform")
    });
    write_response(&response);
}

#[cfg(not(test))]
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
    fn only_explicit_authorization_can_prompt() {
        for (operation, fields) in [
            ("probe", r#""#),
            ("get", r#""#),
            ("set", r#", "value":"fixture""#),
            ("delete", r#""#),
            ("authorize", r#""#),
        ] {
            let request_fields = format!(
                r#""op":"{operation}","service":"codelia.auth","account":"codelia-0123456789abcdef"{fields}"#
            );
            assert!(
                !parse_request(&format!("{{{request_fields}}}"))
                    .unwrap()
                    .allows_prompt()
            );
            assert!(
                !parse_request(&format!(r#"{{{request_fields},"allow_prompt":false}}"#))
                    .unwrap()
                    .allows_prompt()
            );
            assert_eq!(
                parse_request(&format!(r#"{{{request_fields},"allow_prompt":true}}"#))
                    .unwrap()
                    .allows_prompt(),
                operation == "authorize",
            );
        }
    }

    #[test]
    fn malformed_request_does_not_echo_input() {
        let result = parse_request(
            r#"{"op":"authorize","service":"codelia.auth","account":"codelia-0123456789abcdef","allow_prompt":"fixture private input"}"#,
        );
        assert_eq!(
            result.err(),
            Some(Response::err("invalid_request", "invalid JSON request"))
        );
    }

    #[test]
    fn rejects_empty_or_control_char_identifiers() {
        let resp = handle_request(
            Request::Get {
                service: "".to_string(),
                account: "codelia-abc".to_string(),
            },
            |_| panic!("invalid request reached the backend"),
        );
        assert_eq!(
            resp,
            Response::Err {
                ok: false,
                code: "invalid_request".to_string(),
                message: "invalid service".to_string(),
            }
        );

        let resp2 = handle_request(
            Request::Delete {
                service: "codelia.auth".to_string(),
                account: "bad\naccount".to_string(),
            },
            |_| panic!("invalid request reached the backend"),
        );
        assert_eq!(
            resp2,
            Response::Err {
                ok: false,
                code: "invalid_request".to_string(),
                message: "invalid account".to_string(),
            }
        );
    }

    #[test]
    fn authorization_rejects_other_services_and_accounts() {
        for (service, account) in [
            ("other.service", "codelia-0123456789abcdef"),
            ("codelia.auth", "other-account"),
        ] {
            let response = handle_request(
                Request::Authorize {
                    service: service.into(),
                    account: account.into(),
                    allow_prompt: true,
                },
                |_| panic!("invalid request reached the backend"),
            );
            assert_eq!(
                response,
                Response::err("invalid_request", "authorization requires a Codelia item"),
            );
        }
    }

    #[test]
    fn authorization_only_returns_metadata() {
        let response = handle_request(
            Request::Authorize {
                service: "codelia.mcp-auth".into(),
                account: "codelia-0123456789abcdef".into(),
                allow_prompt: true,
            },
            |request| {
                assert!(request.allows_prompt());
                Response::AuthorizeOk {
                    ok: true,
                    found: true,
                    authorized: true,
                }
            },
        );
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({"ok": true, "found": true, "authorized": true})
        );
    }
}
