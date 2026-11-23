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

pub use generated::*;

use serde::de::{value::MapAccessDeserializer, DeserializeOwned, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::fmt;

/// Optional field whose absence and `null` mean different things.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Patch<T> {
    /// Key omitted: keep the current value.
    #[default]
    Absent,
    /// Explicit `null`: clear the current value.
    Null,
    Value(T),
}

impl<T> Patch<T> {
    pub fn is_absent(&self) -> bool {
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

/// Decode the value of a present optional key. If T accepts null (e.g. Value),
/// keep it as Some; otherwise reject it. Missing keys use the field's default.
pub(crate) fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Restrict a derived struct decoder to maps. Serde's struct decoder also
/// accepts sequences by default, even inside untagged unions.
pub(crate) trait ObjectDecode<'de>: Sized {
    fn decode_map<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error>;

    fn deserialize_object<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: ObjectDecode<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = T;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
                T::decode_map(MapAccessDeserializer::new(map))
            }
        }

        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

/// A number in the same safe-integer range as Zod's wireInt. JSON decimal
/// and exponent spellings are accepted when their numeric value is integral.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct WireInt(i64);

impl<'de> Deserialize<'de> for WireInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        const MAX: f64 = 9_007_199_254_740_991.0;
        let value = f64::deserialize(deserializer)?;
        if value.fract() == 0.0 && (-MAX..=MAX).contains(&value) {
            Ok(Self(value as i64))
        } else {
            Err(serde::de::Error::custom("expected a safe integer"))
        }
    }
}

// Scalar struct fields retain their existing i64 API for TUI callers.
pub(crate) fn deserialize_int<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    WireInt::deserialize(d).map(|value| value.0)
}

pub(crate) fn deserialize_int_present<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<i64>, D::Error> {
    deserialize_int(d).map(Some)
}

pub(crate) fn deserialize_int_nullable<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<i64>, D::Error> {
    Option::<WireInt>::deserialize(d).map(|value| value.map(|value| value.0))
}

pub(crate) fn deserialize_int_patch<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Patch<i64>, D::Error> {
    deserialize_int_nullable(d).map(|value| value.map_or(Patch::Null, Patch::Value))
}

/// An integer literal such as subagent lineage depth 1.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ConstInt<const V: i64>;

impl<const V: i64> Serialize for ConstInt<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(V)
    }
}

impl<'de, const V: i64> Deserialize<'de> for ConstInt<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if deserialize_int(deserializer)? == V {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format_args!("expected {V}")))
        }
    }
}

/// A boolean literal such as `ok: true`. Decoding fails on the other value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ConstBool<const V: bool>;

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
pub struct DecodeError {
    pub method: String,
    pub source: serde_json::Error,
}

impl DecodeError {
    pub fn decode<T: DeserializeOwned>(method: &str, value: Value) -> Result<T, Self> {
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
pub fn redact_values(message: &str) -> String {
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
pub enum IncomingMessage {
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
    pub fn classify(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id").and_then(Value::as_str).map(str::to_owned);
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            let method = method.to_owned();
            return Some(match id {
                Some(id) => Self::Request { id, method, params },
                None => Self::Notification { method, params },
            });
        }
        let id = id?;
        let result = object.get("result").cloned();
        let error = object.get("error").cloned();
        if result.is_none() && error.is_none() {
            return None;
        }
        Some(Self::Response { id, result, error })
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
pub fn request_line<R: ClientRequest>(id: &str, params: &R::Params) -> String {
    line(json!({"jsonrpc": "2.0", "id": id, "method": R::METHOD, "params": to_value(params)}))
}

/// Serialized notification line for a catalogued UI -> runtime notification.
pub fn notification_line<N: ClientNotification>(params: &N::Params) -> String {
    line(json!({"jsonrpc": "2.0", "method": N::METHOD, "params": to_value(params)}))
}

/// Serialized reply line for a runtime -> UI request.
pub fn reply_line<R: ServerRequestReply>(id: &str, result: &R::Result) -> String {
    line(json!({"jsonrpc": "2.0", "id": id, "result": to_value(result)}))
}

/// Serialized JSON-RPC error reply for a runtime -> UI request.
pub fn error_reply_line(id: &str, code: i64, message: &str, data: Option<Value>) -> String {
    let mut error = json!({"code": code, "message": message});
    if let Some(data) = data {
        error["data"] = data;
    }
    line(json!({"jsonrpc": "2.0", "id": id, "error": error}))
}

/// Decodes the result of a UI -> runtime request with its catalogued type.
pub fn decode_result<R: ClientRequest>(result: Value) -> Result<R::Result, DecodeError> {
    DecodeError::decode(R::METHOD, result)
}
