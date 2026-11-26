pub(crate) mod input;
pub(crate) mod runtime;

use std::sync::mpsc::Receiver;

pub(crate) type RuntimeReceiver = Receiver<String>;
