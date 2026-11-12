/// Every way a `btc` call can fail. The contract maps these to refusals; nothing here panics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BtcError {
    /// The transaction bytes end before the transaction does.
    Truncated,
    /// Bytes are left over after a complete transaction.
    TrailingBytes,
    /// A length prefix is not in its shortest form, or claims more items than the bytes can hold.
    BadCount,
    /// A 0x00 marker not followed by the 0x01 segwit flag.
    BadSegwitFlag,
    /// A transaction must spend at least one input.
    NoInputs,
    /// Not a valid bech32 segwit address.
    AddressInvalid,
    /// A valid segwit address for another network.
    AddressWrongNetwork,
    /// A valid segwit address of witness version 1 or later (taproot and beyond).
    AddressNotSegwitV0,
    /// A jar locktime must be a time in seconds (at least 500,000,000), not a block height.
    LocktimeNotATime,
    /// A signature's r or s is zero or not below the curve order.
    InvalidSignature,
    /// A signed transaction needs exactly one witness per input.
    WitnessCountMismatch,
    /// The input index is not in the transaction.
    InputOutOfRange,
}
