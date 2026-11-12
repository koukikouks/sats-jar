use near_sdk_env::sha256_array;

/// SHA256d, Bitcoin's double SHA-256 (txids, BIP-143 hashes).
pub(crate) fn sha256d(bytes: &[u8]) -> [u8; 32] {
    sha256_array(sha256_array(bytes))
}
