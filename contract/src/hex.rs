//! Hex for JSON arguments and views.

pub fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `None` unless `text` is an even number of hex digits.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// A hash in internal byte order as explorers print it (reversed).
pub fn display(hash: &[u8; 32]) -> String {
    let mut reversed = *hash;
    reversed.reverse();
    encode(&reversed)
}
