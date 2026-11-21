use crate::Response;

pub const ERR_SEC_SUCCESS: i32 = 0;
const ERR_SEC_USER_CANCELED: i32 = -128;
const ERR_SEC_AUTH_FAILED: i32 = -25293;
const ERR_SEC_NO_DEFAULT_KEYCHAIN: i32 = -25307;
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
const ERR_SEC_INTERACTION_REQUIRED: i32 = -25315;
const ERR_SEC_IN_DARK_WAKE: i32 = -25320;

const SESSION_HAS_GRAPHIC_ACCESS: u32 = 0x0010;
const SESSION_IS_REMOTE: u32 = 0x1000;

pub fn require_local_gui(status: i32, attributes: u32) -> Result<(), Response> {
    if status != ERR_SEC_SUCCESS
        || attributes & SESSION_HAS_GRAPHIC_ACCESS == 0
        || attributes & SESSION_IS_REMOTE != 0
    {
        return Err(Response::err(
            "access_denied",
            "Run `codelia auth authorize-keychain` in a local macOS graphical session.",
        ));
    }
    Ok(())
}

pub fn locked_response() -> Response {
    Response::err(
        "locked",
        "macOS login Keychain is locked; run `security unlock-keychain ~/Library/Keychains/login.keychain-db`",
    )
}

pub fn classify_operation_error(
    status: i32,
    action: &str,
    keychain_status: impl FnOnce() -> Result<(), Response>,
) -> Response {
    match status {
        ERR_SEC_INTERACTION_NOT_ALLOWED
        | ERR_SEC_INTERACTION_REQUIRED
        | ERR_SEC_IN_DARK_WAKE
        | ERR_SEC_AUTH_FAILED
        | ERR_SEC_USER_CANCELED => {
            // The Keychain may have locked since the operation started.
            if let Err(response) = keychain_status() {
                if matches!(&response, Response::Err { code, .. } if code == "locked") {
                    return response;
                }
            }
            Response::err(
                "access_denied",
                format!(
                    "macOS Keychain denied access during {action} (OSStatus {status}); run `codelia auth authorize-keychain` from a local terminal to authorize this helper"
                ),
            )
        }
        ERR_SEC_NO_DEFAULT_KEYCHAIN => Response::err(
            "unavailable",
            format!("no default macOS Keychain available ({status})"),
        ),
        _ => Response::err(
            "error",
            format!("macOS Keychain {action} failed (OSStatus {status})"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_require_the_local_graphical_session() {
        for (status, attributes) in [
            (-60500, SESSION_HAS_GRAPHIC_ACCESS),
            (ERR_SEC_SUCCESS, 0),
            (
                ERR_SEC_SUCCESS,
                SESSION_HAS_GRAPHIC_ACCESS | SESSION_IS_REMOTE,
            ),
        ] {
            assert!(
                matches!(require_local_gui(status, attributes), Err(Response::Err { code, .. }) if code == "access_denied")
            );
        }
        assert_eq!(
            require_local_gui(ERR_SEC_SUCCESS, SESSION_HAS_GRAPHIC_ACCESS),
            Ok(())
        );
    }

    #[test]
    fn authorization_failures_distinguish_acl_denial_from_a_relocked_keychain() {
        for status in [
            ERR_SEC_INTERACTION_NOT_ALLOWED,
            ERR_SEC_INTERACTION_REQUIRED,
            ERR_SEC_IN_DARK_WAKE,
            ERR_SEC_AUTH_FAILED,
            ERR_SEC_USER_CANCELED,
        ] {
            let denied = classify_operation_error(status, "read", || Ok(()));
            assert!(
                matches!(denied, Response::Err { code, message, .. } if code == "access_denied" && message.contains("codelia auth authorize-keychain"))
            );
            assert_eq!(
                classify_operation_error(status, "read", || Err(locked_response())),
                locked_response()
            );
        }
    }
}
