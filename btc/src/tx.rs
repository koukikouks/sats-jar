use crate::error::BtcError;
use crate::hash::sha256d;

/// A reference to an earlier transaction's output. `txid` is in internal byte order
/// (SHA256d output as is; explorers show it reversed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutPoint {
    pub txid: [u8; 32],
    pub vout: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxIn {
    pub previous_output: OutPoint,
    pub script_sig: Vec<u8>,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOut {
    /// Sats.
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

/// A Bitcoin transaction without its witnesses: what the txid and BIP-143 sighashes cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub version: u32,
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
    pub lock_time: u32,
}

impl Transaction {
    /// Parses a serialised transaction. Witnesses are read and dropped.
    pub fn parse(bytes: &[u8]) -> Result<Transaction, BtcError> {
        let mut r = Reader { bytes, pos: 0 };
        let version = r.u32()?;
        // BIP-144: a 0x00 marker where the input count would be, then a 0x01 flag.
        let segwit = r.read_segwit_marker()?;
        let input_count = r.count(MIN_INPUT_LEN)?;
        if input_count == 0 {
            return Err(BtcError::NoInputs);
        }
        let mut inputs = Vec::with_capacity(input_count);
        for _ in 0..input_count {
            let txid = r.array::<32>()?;
            let vout = r.u32()?;
            let script_sig = r.var_bytes()?.to_vec();
            let sequence = r.u32()?;
            inputs.push(TxIn {
                previous_output: OutPoint { txid, vout },
                script_sig,
                sequence,
            });
        }
        let output_count = r.count(MIN_OUTPUT_LEN)?;
        let mut outputs = Vec::with_capacity(output_count);
        for _ in 0..output_count {
            let value = r.u64()?;
            let script_pubkey = r.var_bytes()?.to_vec();
            outputs.push(TxOut {
                value,
                script_pubkey,
            });
        }
        if segwit {
            for _ in 0..input_count {
                let items = r.count(1)?;
                for _ in 0..items {
                    r.var_bytes()?;
                }
            }
        }
        let lock_time = r.u32()?;
        if r.pos != bytes.len() {
            return Err(BtcError::TrailingBytes);
        }
        Ok(Transaction {
            version,
            inputs,
            outputs,
            lock_time,
        })
    }

    /// An unsigned payment spending `inputs` (segwit, so empty scriptSigs) to `outputs`,
    /// in the order given. Version 2, lock time 0, and every input signals RBF (BIP-125),
    /// so a stuck payment can later be replaced at a higher fee (ADR 0006).
    pub fn payment(inputs: &[OutPoint], outputs: Vec<TxOut>) -> Transaction {
        Transaction {
            version: 2,
            inputs: inputs
                .iter()
                .map(|&previous_output| TxIn {
                    previous_output,
                    script_sig: Vec::new(),
                    sequence: SEQUENCE_RBF,
                })
                .collect(),
            outputs,
            lock_time: 0,
        }
    }

    /// The txid in internal byte order: SHA256d of the serialisation without witnesses.
    pub fn txid(&self) -> [u8; 32] {
        sha256d(&self.to_bytes_without_witnesses())
    }

    /// A coinbase has exactly one input, spending the null outpoint.
    pub fn is_coinbase(&self) -> bool {
        matches!(self.inputs.as_slice(), [only] if only.previous_output == OutPoint { txid: [0; 32], vout: u32::MAX })
    }

    /// The signed transaction in segwit serialisation, with one witness (a list of items) per input.
    pub fn to_signed_bytes(&self, witnesses: &[Vec<Vec<u8>>]) -> Result<Vec<u8>, BtcError> {
        if witnesses.len() != self.inputs.len() {
            return Err(BtcError::WitnessCountMismatch);
        }
        Ok(self.serialise(Some(witnesses)))
    }

    fn to_bytes_without_witnesses(&self) -> Vec<u8> {
        self.serialise(None)
    }

    fn serialise(&self, witnesses: Option<&[Vec<Vec<u8>>]>) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.version.to_le_bytes());
        if witnesses.is_some() {
            buf.extend_from_slice(&[SEGWIT_MARKER, SEGWIT_FLAG]);
        }
        write_compact_size(&mut buf, self.inputs.len() as u64);
        for input in &self.inputs {
            write_outpoint(&mut buf, &input.previous_output);
            write_var_bytes(&mut buf, &input.script_sig);
            buf.extend_from_slice(&input.sequence.to_le_bytes());
        }
        write_compact_size(&mut buf, self.outputs.len() as u64);
        for output in &self.outputs {
            write_output(&mut buf, output);
        }
        for witness in witnesses.unwrap_or_default() {
            write_compact_size(&mut buf, witness.len() as u64);
            for item in witness {
                write_var_bytes(&mut buf, item);
            }
        }
        buf.extend_from_slice(&self.lock_time.to_le_bytes());
        buf
    }

    /// BIP-143 signature hash with SIGHASH_ALL for `input`, which spends `value` sats
    /// under `script_code` (the witness script for P2WSH).
    pub fn sighash_all(
        &self,
        input: usize,
        script_code: &[u8],
        value: u64,
    ) -> Result<[u8; 32], BtcError> {
        let this = self.inputs.get(input).ok_or(BtcError::InputOutOfRange)?;

        let mut prevouts = Vec::with_capacity(36 * self.inputs.len());
        let mut sequences = Vec::with_capacity(4 * self.inputs.len());
        for i in &self.inputs {
            write_outpoint(&mut prevouts, &i.previous_output);
            sequences.extend_from_slice(&i.sequence.to_le_bytes());
        }
        let mut outputs = Vec::new();
        for o in &self.outputs {
            write_output(&mut outputs, o);
        }

        let mut preimage = Vec::with_capacity(160 + script_code.len());
        preimage.extend_from_slice(&self.version.to_le_bytes());
        preimage.extend_from_slice(&sha256d(&prevouts));
        preimage.extend_from_slice(&sha256d(&sequences));
        write_outpoint(&mut preimage, &this.previous_output);
        write_var_bytes(&mut preimage, script_code);
        preimage.extend_from_slice(&value.to_le_bytes());
        preimage.extend_from_slice(&this.sequence.to_le_bytes());
        preimage.extend_from_slice(&sha256d(&outputs));
        preimage.extend_from_slice(&self.lock_time.to_le_bytes());
        preimage.extend_from_slice(&SIGHASH_ALL.to_le_bytes());
        Ok(sha256d(&preimage))
    }
}

const SIGHASH_ALL: u32 = 1;
const SEQUENCE_RBF: u32 = 0xffff_fffd;
const SEGWIT_MARKER: u8 = 0x00;
const SEGWIT_FLAG: u8 = 0x01;
/// Smallest possible serialised input and output, to bound counts by the bytes left.
const MIN_INPUT_LEN: usize = 32 + 4 + 1 + 4;
const MIN_OUTPUT_LEN: usize = 8 + 1;

fn write_outpoint(buf: &mut Vec<u8>, outpoint: &OutPoint) {
    buf.extend_from_slice(&outpoint.txid);
    buf.extend_from_slice(&outpoint.vout.to_le_bytes());
}

fn write_output(buf: &mut Vec<u8>, output: &TxOut) {
    buf.extend_from_slice(&output.value.to_le_bytes());
    write_var_bytes(buf, &output.script_pubkey);
}

fn write_var_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
    write_compact_size(buf, bytes.len() as u64);
    buf.extend_from_slice(bytes);
}

fn write_compact_size(buf: &mut Vec<u8>, n: u64) {
    match n {
        0..=0xfc => buf.push(n as u8),
        0xfd..=0xffff => {
            buf.push(0xfd);
            buf.extend_from_slice(&(n as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            buf.push(0xfe);
            buf.extend_from_slice(&(n as u32).to_le_bytes());
        }
        _ => {
            buf.push(0xff);
            buf.extend_from_slice(&n.to_le_bytes());
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], BtcError> {
        let end = self.pos.checked_add(n).ok_or(BtcError::Truncated)?;
        let slice = self.bytes.get(self.pos..end).ok_or(BtcError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], BtcError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    /// Consumes the segwit marker and flag if present.
    fn read_segwit_marker(&mut self) -> Result<bool, BtcError> {
        if self.bytes.get(self.pos) != Some(&SEGWIT_MARKER) {
            return Ok(false);
        }
        if self.bytes.get(self.pos + 1) != Some(&SEGWIT_FLAG) {
            return Err(BtcError::BadSegwitFlag);
        }
        self.pos += 2;
        Ok(true)
    }

    fn u32(&mut self) -> Result<u32, BtcError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, BtcError> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    /// Bitcoin's CompactSize, shortest form only (as Core requires).
    fn compact_size(&mut self) -> Result<u64, BtcError> {
        let first = self.array::<1>()?[0];
        let (n, min) = match first {
            0xfd => (u64::from(u16::from_le_bytes(self.array()?)), 0xfd),
            0xfe => (u64::from(u32::from_le_bytes(self.array()?)), 0x1_0000),
            0xff => (u64::from_le_bytes(self.array()?), 0x1_0000_0000),
            n => return Ok(u64::from(n)),
        };
        if n < min {
            return Err(BtcError::BadCount);
        }
        Ok(n)
    }

    /// A count of items each at least `min_len` bytes long, refused if the bytes left cannot hold them.
    fn count(&mut self, min_len: usize) -> Result<usize, BtcError> {
        let n = self.compact_size()?;
        let left = (self.bytes.len() - self.pos) as u64;
        if n.checked_mul(min_len as u64).is_none_or(|need| need > left) {
            return Err(BtcError::BadCount);
        }
        Ok(n as usize)
    }

    fn var_bytes(&mut self) -> Result<&'a [u8], BtcError> {
        let n = self.count(1)?;
        self.take(n)
    }
}
