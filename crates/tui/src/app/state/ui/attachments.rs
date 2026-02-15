#[derive(Clone, Debug)]
pub struct PendingImageAttachment {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub encoded_bytes: usize,
}
