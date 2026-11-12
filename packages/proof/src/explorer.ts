// Testnet explorers. NearBlocks is the form T06's evidence links to; mempool.space is testnet3.
export const nearTransactionUrl = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
export const bitcoinTransactionUrl = (txid: string): string => `https://mempool.space/testnet/tx/${txid}`;
export const bitcoinAddressUrl = (address: string): string => `https://mempool.space/testnet/address/${address}`;
