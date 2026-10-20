import { Networks } from "@stellar/stellar-sdk";
import { env } from "../config/env";
import {
  CertificateIndexerService,
  mongoCertificateIndexerStore,
} from "../services/certificateIndexer.service";
import { sorobanService } from "../services/soroban.service";
import logger from "../utils/logger";

export type StopCertificateIndexer = () => void;

/**
 * Starts a serial polling loop that backfills Certificate cache rows from
 * CertificateMinted events. A slow cycle never overlaps the next one.
 */
export function startCertificateIndexerJob(): StopCertificateIndexer {
  const service = new CertificateIndexerService(sorobanService, mongoCertificateIndexerStore, {
    provenanceContractId: env.STELLAR_PROVENANCE_CONTRACT_ID,
    stellarNetwork: env.STELLAR_NETWORK_PASSPHRASE === Networks.PUBLIC ? "mainnet" : "testnet",
    startLedger: env.EVENT_INGESTION_START_LEDGER,
    limit: env.EVENT_INGESTION_LIMIT,
  });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async (): Promise<void> => {
    try {
      const result = await service.indexOnce();
      if (result.indexed > 0) logger.info("Certificate cache backfilled", result);
    } catch (error) {
      logger.error("Certificate indexing failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopped) timer = setTimeout(() => void run(), env.EVENT_INGESTION_POLL_INTERVAL_MS);
    }
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
