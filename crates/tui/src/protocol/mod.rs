//! Runtime <-> UI wire protocol.
//!
//! `generated.rs` holds the wire types and method markers generated from the
//! `@codelia/protocol` catalog (`bun run generate:protocol`). This file holds
//! the hand-written pieces: presence handling, decode errors and the JSON-RPC
//! envelope. Spec: dev-docs/specs/protocol-codegen.md.

#[rustfmt::skip]
mod generated;
#[cfg(test)]
mod tests;

pub(crate) use generated::*;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::fmt;

/// Optional field whose absence and `null` mean different things.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Patch<T> {
    /// Key omitted: keep the current value.
    #[default]
    Absent,
    /// Explicit `null`: clear the current value.
    Null,
    Value(T),
}

impl<T> Patch<T> {
    pub(crate) fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(value) => value.serialize(serializer),
            // `Absent` is skipped by `skip_serializing_if`; writing it would
            // otherwise be indistinguishable from `Null`.
            Self::Absent | Self::Null => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Option::<T>::deserialize(deserializer)?.map_or(Self::Null, Self::Value))
    }
}

/// Decodes a required nullable key. serde would otherwise treat a missing
/// `Option` field as `None`.
pub(crate) fn deserialize_required_nullable<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Decodes a present optional opaque value, `null` included, as `Some`. serde
/// would otherwise read an explicit `null` as an absent `None`.
pub(crate) fn deserialize_present<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// A boolean literal such as `ok: true`. Decoding fails on the other value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ConstBool<const V: bool>;

impl<const V: bool> Default for ConstBool<V> {
    fn default() -> Self {
        Self
    }
}

impl<const V: bool> Serialize for ConstBool<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(V)
    }
}

impl<'de, const V: bool> Deserialize<'de> for ConstBool<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == V {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format_args!("expected `{V}`")))
        }
    }
}

/// A known method or tag whose payload does not match the contract.
#[derive(Debug)]
pub(crate) struct DecodeError {
    pub(crate) method: String,
    pub(crate) source: serde_json::Error,
}

impl DecodeError {
    pub(crate) fn decode<T: DeserializeOwned>(method: &str, value: Value) -> Result<T, Self> {
        serde_json::from_value(value).map_err(|source| Self {
            method: method.to_owned(),
            source,
        })
    }
}

impl fmt::Display for DecodeError {
    /// Names the method and the failing field or tag; payload values are
    /// removed so the message is safe for logs and the transcript.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "protocol mismatch in {}: {}",
            self.method,
            redact_values(&self.source.to_string())
        )
    }
}

/// Removes literal values from serde error messages, keeping their kinds
/// (`invalid type: string "secret"` becomes `invalid type: string`).
pub(crate) fn redact_values(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    loop {
        let next = [
            ("string \"", '"'),
            ("integer `", '`'),
            ("floating point `", '`'),
            ("boolean `", '`'),
            ("char '", '\''),
        ]
        .into_iter()
        .filter_map(|(marker, close)| rest.find(marker).map(|at| (at, marker, close)))
        .min_by_key(|(at, _, _)| *at);
        let Some((at, marker, close)) = next else {
            out.push_str(rest);
            return out;
        };
        let kind_end = at + marker.len() - 2;
        out.push_str(&rest[..kind_end]);
        let mut chars = rest[at + marker.len()..].char_indices();
        let mut end = rest.len();
        while let Some((offset, ch)) = chars.next() {
            if ch == '\\' {
                chars.next();
                continue;
            }
            if ch == close {
                end = at + marker.len() + offset + ch.len_utf8();
                break;
            }
        }
        rest = &rest[end..];
    }
}

/// One JSON-RPC message from the runtime, classified by its keys.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum IncomingMessage {
    Request {
        id: String,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: String,
        result: Option<Value>,
        error: Option<Value>,
    },
}

impl IncomingMessage {
    /// `id` + `method` is a request, `method` alone a notification, and `id`
    /// with `result` or `error` a response. Anything else is not a message.
    pub(crate) fn classify(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id").and_then(Value::as_str).map(str::to_owned);
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let method = method.to_owned();
            return Some(match id {
                Some(id) => Self::Request { id, method, params },
                None => Self::Notification { method, params },
            });
        }
        let result = object.get("result").cloned();
        let error = object.get("error").cloned();
        match id {
            Some(id) if result.is_some() || error.is_some() => {
                Some(Self::Response { id, result, error })
            }
            _ => None,
        }
    }
}

fn line(value: Value) -> String {
    value.to_string() + "\n"
}

fn to_value<T: Serialize>(value: &T) -> Value {
    // Generated wire types only contain JSON-representable data.
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Serialized request line for a catalogued UI -> runtime request.
pub(crate) fn request_line<R: ClientRequest>(id: &str, params: &R::Params) -> String {
    line(json!({"jsonrpc": "2.0", "id": id, "method": R::METHOD, "params": to_value(params)}))
}

/// Serialized notification line for a catalogued UI -> runtime notification.
// The TUI sends no notification today; `ui.context.update` is for editor hosts.
#[allow(dead_code)]
pub(crate) fn notification_line<N: ClientNotification>(params: &N::Params) -> String {
    line(json!({"jsonrpc": "2.0", "method": N::METHOD, "params": to_value(params)}))
}

/// Serialized reply line for a runtime -> UI request.
pub(crate) fn reply_line<R: ServerRequestReply>(id: &str, result: &R::Result) -> String {
    line(json!({"jsonrpc": "2.0", "id": id, "result": to_value(result)}))
}

/// Decodes the result of a UI -> runtime request with its catalogued type.
pub(crate) fn decode_result<R: ClientRequest>(result: Value) -> Result<R::Result, DecodeError> {
    DecodeError::decode(R::METHOD, result)
}
