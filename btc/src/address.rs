//! Native segwit v0 addresses (BIP-173 bech32). Taproot and later versions are refused:
//! the MPC network cannot sign Schnorr (ADR 0006), and a child's address must be P2WPKH.

use crate::error::BtcError;
use near_sdk_env::sha256_array;

/// The Bitcoin network the contract is configured for; it fixes the address prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
    Regtest,
}

impl Network {
    fn hrp(self) -> &'static str {
        match self {
            Network::Mainnet => "bc",
            Network::Testnet => "tb",
            Network::Regtest => "bcrt",
        }
    }
}

/// A witness v0 address: a key hash (P2WPKH) or a script hash (P2WSH).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegwitAddress {
    P2wpkh([u8; 20]),
    P2wsh([u8; 32]),
}

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST: u32 = 1;
const BECH32M_CONST: u32 = 0x2bc8_30a3;

impl SegwitAddress {
    /// Validates `address` for `network`: bech32 checksum, prefix, witness v0, program length.
    pub fn decode(address: &str, network: Network) -> Result<SegwitAddress, BtcError> {
        let (hrp, data) = parse_bech32(address)?;
        if hrp != network.hrp() {
            return Err(BtcError::AddressWrongNetwork);
        }
        let checksum = polymod_of(&hrp, &data);
        let payload = &data[..data.len() - 6];
        let (&version, groups) = payload.split_first().ok_or(BtcError::AddressInvalid)?;
        let program = from_5_bit(groups).ok_or(BtcError::AddressInvalid)?;
        match (version, checksum, program.len()) {
            (0, BECH32_CONST, 20) => Ok(SegwitAddress::P2wpkh(to_array(&program)?)),
            (0, BECH32_CONST, 32) => Ok(SegwitAddress::P2wsh(to_array(&program)?)),
            (1..=16, BECH32M_CONST, 2..=40) => Err(BtcError::AddressNotSegwitV0),
            _ => Err(BtcError::AddressInvalid),
        }
    }

    /// The P2WSH address of `witness_script`: its single SHA-256 (BIP-141).
    pub fn p2wsh(witness_script: &[u8]) -> SegwitAddress {
        SegwitAddress::P2wsh(sha256_array(witness_script))
    }

    /// The lowercase bech32 address on `network`.
    pub fn encode(&self, network: Network) -> String {
        let hrp = network.hrp();
        let mut data = vec![0u8];
        data.extend(to_5_bit(self.program()));
        let mut values = hrp_expand(hrp);
        values.extend_from_slice(&data);
        values.extend_from_slice(&[0; 6]);
        let checksum = polymod(&values) ^ BECH32_CONST;
        data.extend((0..6).map(|i| ((checksum >> (5 * (5 - i))) & 31) as u8));

        let mut out = String::with_capacity(hrp.len() + 1 + data.len());
        out.push_str(hrp);
        out.push('1');
        out.extend(data.iter().map(|&d| CHARSET[d as usize] as char));
        out
    }

    /// `OP_0 <program>`, the output script that pays this address.
    pub fn script_pubkey(&self) -> Vec<u8> {
        let program = self.program();
        let mut script = Vec::with_capacity(2 + program.len());
        script.push(0x00);
        script.push(program.len() as u8);
        script.extend_from_slice(program);
        script
    }

    fn program(&self) -> &[u8] {
        match self {
            SegwitAddress::P2wpkh(hash) => hash,
            SegwitAddress::P2wsh(hash) => hash,
        }
    }
}

/// Splits a bech32 string into its lowercase HRP and 5-bit data (checksum included),
/// checking length, characters and case. The checksum constant is checked by the caller.
fn parse_bech32(address: &str) -> Result<(String, Vec<u8>), BtcError> {
    if address.len() > 90 || !address.bytes().all(|b| (33..=126).contains(&b)) {
        return Err(BtcError::AddressInvalid);
    }
    let has_lower = address.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = address.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(BtcError::AddressInvalid);
    }
    let lower = address.to_ascii_lowercase();
    let separator = lower.rfind('1').ok_or(BtcError::AddressInvalid)?;
    if separator == 0 || lower.len() - separator - 1 < 6 {
        return Err(BtcError::AddressInvalid);
    }
    let data = lower[separator + 1..]
        .bytes()
        .map(|c| {
            CHARSET
                .iter()
                .position(|&x| x == c)
                .map(|p| p as u8)
                .ok_or(BtcError::AddressInvalid)
        })
        .collect::<Result<Vec<u8>, BtcError>>()?;
    Ok((lower[..separator].to_owned(), data))
}

fn to_array<const N: usize>(bytes: &[u8]) -> Result<[u8; N], BtcError> {
    bytes.try_into().map_err(|_| BtcError::AddressInvalid)
}

fn polymod_of(hrp: &str, data: &[u8]) -> u32 {
    let mut values = hrp_expand(hrp);
    values.extend_from_slice(data);
    polymod(&values)
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut out: Vec<u8> = hrp.bytes().map(|b| b >> 5).collect();
    out.push(0);
    out.extend(hrp.bytes().map(|b| b & 31));
    out
}

fn polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut chk: u32 = 1;
    for &v in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ u32::from(v);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn to_5_bit(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() * 8 / 5 + 1);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        out.push(((acc << (5 - bits)) & 31) as u8);
    }
    out
}

/// 5-bit groups back to bytes; refuses more than 4 bits of padding or non-zero padding (BIP-173).
fn from_5_bit(groups: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(groups.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &g in groups {
        acc = ((acc << 5) | u32::from(g)) & 0xfff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    if bits >= 5 || (acc << (8 - bits)) & 0xff != 0 {
        return None;
    }
    Some(out)
}
