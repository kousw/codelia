use crate::keychain_policy::{
    ERR_SEC_SUCCESS, classify_operation_error, locked_response, require_local_gui,
};
use crate::{Request, Response};
use std::ffi::c_void;
use std::ptr;

type OSStatus = i32;
type CFIndex = isize;
type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFStringRef = *const c_void;
type CFDataRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFMutableDictionaryRef = *mut c_void;
type CFBooleanRef = *const c_void;
type SecKeychainRef = *mut c_void;
type SecKeychainStatus = u32;

const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;

const K_SEC_UNLOCK_STATE_STATUS: SecKeychainStatus = 0x1;
const CALLER_SECURITY_SESSION: u32 = u32::MAX;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFAllocatorDefault: CFAllocatorRef;
    static kCFBooleanTrue: CFBooleanRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;

    fn CFRelease(cf: CFTypeRef);
    fn CFStringCreateWithBytes(
        alloc: CFAllocatorRef,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFStringRef;
    fn CFDataCreate(alloc: CFAllocatorRef, bytes: *const u8, length: CFIndex) -> CFDataRef;
    fn CFDataGetLength(the_data: CFDataRef) -> CFIndex;
    fn CFDataGetBytePtr(the_data: CFDataRef) -> *const u8;
    fn CFDictionaryCreateMutable(
        allocator: CFAllocatorRef,
        capacity: CFIndex,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFMutableDictionaryRef;
    fn CFDictionarySetValue(the_dict: CFMutableDictionaryRef, key: CFTypeRef, value: CFTypeRef);
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecClass: CFStringRef;
    static kSecClassGenericPassword: CFStringRef;
    static kSecAttrService: CFStringRef;
    static kSecAttrAccount: CFStringRef;
    static kSecValueData: CFStringRef;
    static kSecReturnData: CFStringRef;
    static kSecMatchLimit: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;

    fn SessionGetInfo(session: u32, session_id: *mut u32, attributes: *mut u32) -> OSStatus;
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> OSStatus;
    fn SecKeychainCopyDefault(keychain: *mut SecKeychainRef) -> OSStatus;
    fn SecKeychainGetStatus(
        keychain: SecKeychainRef,
        keychain_status: *mut SecKeychainStatus,
    ) -> OSStatus;
    fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
    fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
    fn SecItemUpdate(query: CFDictionaryRef, attributes_to_update: CFDictionaryRef) -> OSStatus;
    fn SecItemDelete(query: CFDictionaryRef) -> OSStatus;
}

struct OwnedCf(CFTypeRef);

impl OwnedCf {
    fn new(ptr: CFTypeRef) -> Option<Self> {
        if ptr.is_null() { None } else { Some(Self(ptr)) }
    }

    fn as_ptr(&self) -> CFTypeRef {
        self.0
    }
}

impl Drop for OwnedCf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_string(value: &str) -> Result<OwnedCf, Response> {
    let bytes = value.as_bytes();
    let ptr = unsafe {
        CFStringCreateWithBytes(
            kCFAllocatorDefault,
            bytes.as_ptr(),
            bytes.len() as CFIndex,
            K_CF_STRING_ENCODING_UTF8,
            0,
        )
    };
    OwnedCf::new(ptr).ok_or_else(|| Response::err("error", "CFStringCreateWithBytes failed"))
}

fn cf_data(bytes: &[u8]) -> Result<OwnedCf, Response> {
    let ptr = unsafe { CFDataCreate(kCFAllocatorDefault, bytes.as_ptr(), bytes.len() as CFIndex) };
    OwnedCf::new(ptr).ok_or_else(|| Response::err("error", "CFDataCreate failed"))
}

fn cf_mutable_dict() -> Result<OwnedCf, Response> {
    let ptr = unsafe {
        CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            &kCFTypeDictionaryKeyCallBacks as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const c_void,
        )
    };
    OwnedCf::new(ptr as CFTypeRef)
        .ok_or_else(|| Response::err("error", "CFDictionaryCreateMutable failed"))
}

fn dict_set(dict: &OwnedCf, key: CFTypeRef, value: CFTypeRef) {
    unsafe {
        CFDictionarySetValue(dict.as_ptr() as CFMutableDictionaryRef, key, value);
    }
}

fn classify_os_status(status: OSStatus, action: &str) -> Response {
    classify_operation_error(status, action, ensure_keychain_unlocked)
}

fn ensure_keychain_unlocked() -> Result<(), Response> {
    let mut keychain: SecKeychainRef = ptr::null_mut();
    let copy_status = unsafe { SecKeychainCopyDefault(&mut keychain) };
    if copy_status != ERR_SEC_SUCCESS || keychain.is_null() {
        return Err(Response::err(
            "unavailable",
            format!("cannot open default macOS Keychain (OSStatus {copy_status})"),
        ));
    }
    let _owned_kc = OwnedCf::new(keychain as CFTypeRef);
    let mut kc_status: SecKeychainStatus = 0;
    let status = unsafe { SecKeychainGetStatus(keychain, &mut kc_status) };
    if status != ERR_SEC_SUCCESS {
        return Err(Response::err(
            "error",
            format!("cannot get macOS Keychain status (OSStatus {status})"),
        ));
    }
    if (kc_status & K_SEC_UNLOCK_STATE_STATUS) == 0 {
        return Err(locked_response());
    }
    Ok(())
}

fn base_query(service: &str, account: &str) -> Result<(OwnedCf, OwnedCf, OwnedCf), Response> {
    let dict = cf_mutable_dict()?;
    let cf_service = cf_string(service)?;
    let cf_account = cf_string(account)?;
    unsafe {
        dict_set(&dict, kSecClass, kSecClassGenericPassword);
        dict_set(&dict, kSecAttrService, cf_service.as_ptr());
        dict_set(&dict, kSecAttrAccount, cf_account.as_ptr());
    }
    Ok((dict, cf_service, cf_account))
}

pub fn execute(request: Request) -> Response {
    let allow_interaction = request.allows_prompt();
    if allow_interaction {
        let mut attributes = 0;
        let status =
            unsafe { SessionGetInfo(CALLER_SECURITY_SESSION, ptr::null_mut(), &mut attributes) };
        if let Err(error) = require_local_gui(status, attributes) {
            return error;
        }
    }
    // SecItem targets the file-based Keychain here; its query UI options only
    // suppress authentication UI for the Data Protection Keychain.
    let status = unsafe { SecKeychainSetUserInteractionAllowed(u8::from(allow_interaction)) };
    if status != ERR_SEC_SUCCESS {
        return Response::err(
            "error",
            format!("cannot configure macOS Keychain interaction (OSStatus {status})"),
        );
    }
    if let Err(err) = ensure_keychain_unlocked() {
        return err;
    }

    match request {
        Request::Probe => Response::ProbeOk {
            ok: true,
            status: "available".to_string(),
        },
        Request::Get { service, account } => match get_item(&service, &account) {
            Ok(Some(value)) => Response::GetOk {
                ok: true,
                found: true,
                value: Some(value),
            },
            Ok(None) => Response::GetOk {
                ok: true,
                found: false,
                value: None,
            },
            Err(err) => err,
        },
        Request::Authorize {
            service, account, ..
        } => match copy_item_data(&service, &account) {
            Ok(data) => Response::AuthorizeOk {
                ok: true,
                found: data.is_some(),
                authorized: true,
            },
            Err(err) => err,
        },
        Request::Set {
            service,
            account,
            value,
        } => match set_item(&service, &account, &value) {
            Ok(()) => Response::SetOk { ok: true },
            Err(err) => err,
        },
        Request::Delete { service, account } => match delete_item(&service, &account) {
            Ok(deleted) => Response::DeleteOk { ok: true, deleted },
            Err(err) => err,
        },
    }
}

fn copy_item_data(service: &str, account: &str) -> Result<Option<OwnedCf>, Response> {
    let (query, _s, _a) = base_query(service, account)?;
    unsafe {
        dict_set(&query, kSecReturnData, kCFBooleanTrue);
        dict_set(&query, kSecMatchLimit, kSecMatchLimitOne);
    }
    let mut result: CFTypeRef = ptr::null();
    let status = unsafe { SecItemCopyMatching(query.as_ptr(), &mut result) };
    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(None);
    }
    if status != ERR_SEC_SUCCESS {
        return Err(classify_os_status(status, "read"));
    }
    OwnedCf::new(result)
        .map(Some)
        .ok_or_else(|| Response::err("error", "SecItemCopyMatching returned null data"))
}

fn get_item(service: &str, account: &str) -> Result<Option<String>, Response> {
    let Some(owned) = copy_item_data(service, account)? else {
        return Ok(None);
    };
    let length = unsafe { CFDataGetLength(owned.as_ptr()) };
    if length < 0 {
        return Err(Response::err("error", "negative CFData length"));
    }
    let slice = if length == 0 {
        &[]
    } else {
        let ptr = unsafe { CFDataGetBytePtr(owned.as_ptr()) };
        if ptr.is_null() {
            return Err(Response::err("error", "null CFData byte pointer"));
        }
        unsafe { std::slice::from_raw_parts(ptr, length as usize) }
    };
    let text = String::from_utf8(slice.to_vec())
        .map_err(|_| Response::err("error", "Keychain entry is not valid UTF-8"))?;
    Ok(Some(text))
}

fn set_item(service: &str, account: &str, value: &str) -> Result<(), Response> {
    let (query, _s, _a) = base_query(service, account)?;
    let data = cf_data(value.as_bytes())?;
    let update_attrs = cf_mutable_dict()?;
    unsafe {
        dict_set(&update_attrs, kSecValueData, data.as_ptr());
    }
    let update_status = unsafe { SecItemUpdate(query.as_ptr(), update_attrs.as_ptr()) };
    if update_status == ERR_SEC_SUCCESS {
        return Ok(());
    }
    if update_status != ERR_SEC_ITEM_NOT_FOUND {
        return Err(classify_os_status(update_status, "update"));
    }

    let (add_attrs, _s2, _a2) = base_query(service, account)?;
    unsafe {
        dict_set(&add_attrs, kSecValueData, data.as_ptr());
    }
    let add_status = unsafe { SecItemAdd(add_attrs.as_ptr(), ptr::null_mut()) };
    if add_status == ERR_SEC_SUCCESS {
        return Ok(());
    }
    if add_status == ERR_SEC_DUPLICATE_ITEM {
        let retry_status = unsafe { SecItemUpdate(query.as_ptr(), update_attrs.as_ptr()) };
        if retry_status == ERR_SEC_SUCCESS {
            return Ok(());
        }
        return Err(classify_os_status(retry_status, "update_after_duplicate"));
    }
    Err(classify_os_status(add_status, "add"))
}

fn delete_item(service: &str, account: &str) -> Result<bool, Response> {
    let (query, _s, _a) = base_query(service, account)?;
    let status = unsafe { SecItemDelete(query.as_ptr()) };
    if status == ERR_SEC_SUCCESS {
        return Ok(true);
    }
    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(false);
    }
    Err(classify_os_status(status, "delete"))
}
