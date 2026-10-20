/** Stellar network a certificate was minted on, as stored in the certificate cache. */
export type StellarNetwork = "testnet" | "mainnet";

const STELLAR_EXPERT_BASE_URL = "https://stellar.expert/explorer";

/** stellar.expert URL of a transaction, e.g. the certificate mint. */
export function stellarExplorerTxUrl(network: StellarNetwork, transactionHash: string): string {
  const segment = network === "mainnet" ? "public" : "testnet";
  return `${STELLAR_EXPERT_BASE_URL}/${segment}/tx/${encodeURIComponent(transactionHash)}`;
}
