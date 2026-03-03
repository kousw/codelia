pub(crate) mod input;
pub(crate) mod runtime;

use std::io::BufWriter;
use std::process::ChildStdin;
use std::sync::mpsc::Receiver;

pub(crate) type RuntimeStdin = BufWriter<ChildStdin>;
pub(crate) type RuntimeReceiver = Receiver<String>;
