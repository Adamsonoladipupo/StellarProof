import { nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  CertificateIndexerService,
  certificateIdFromEvent,
  type CertificateIndexerStore,
  type MintedJobRef,
} from "../services/certificateIndexer.service";

const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const MINTED = xdr.ScVal.scvSymbol("CertificateMinted").toXDR("base64");

const JOB: MintedJobRef = {
  jobId: "65b000000000000000000001",
  assetId: "65b000000000000000000002",
  manifestId: "65b000000000000000000003",
  creatorId: "65b000000000000000000004",
};

/** Builds an event whose certificate id is in the topics (the fallback path). */
function topicEvent(id: string, certificateId: bigint, ledger = 100): rpc.Api.EventResponse {
  return {
    id: `evt-${id}`,
    pagingToken: `token-${id}`,
    ledger,
    ledgerClosedAt: "2026-05-01T12:00:00Z",
    txHash: `tx-${id}`,
    topic: [xdr.ScVal.fromXDR(MINTED, "base64"), nativeToScVal(certificateId, { type: "u64" })],
    value: nativeToScVal(null),
  } as unknown as rpc.Api.EventResponse;
}

/** Builds an event whose certificate id is in the payload map. */
function payloadEvent(id: string, certificateId: bigint): rpc.Api.EventResponse {
  return {
    ...topicEvent(id, BigInt(0)),
    value: nativeToScVal({ certificate_id: certificateId }),
  } as unknown as rpc.Api.EventResponse;
}

function fakeStore(overrides: Partial<CertificateIndexerStore> = {}) {
  const store = {
    findMintedJob: jest.fn(async (certificateId: string) => (certificateId === "41" ? JOB : null)),
    insertIfMissing: jest.fn(async () => true),
    getCursor: jest.fn(async () => null),
    saveCursor: jest.fn(async () => undefined),
    ...overrides,
  } as jest.Mocked<CertificateIndexerStore>;
  return store;
}

function fakeRpc(events: rpc.Api.EventResponse[], cursor = "next-page") {
  return {
    getEvents: jest.fn(async () => ({
      events,
      cursor,
      latestLedger: 200,
    })) as unknown as jest.Mock,
  };
}

const config = {
  provenanceContractId: CONTRACT,
  stellarNetwork: "testnet" as const,
  limit: 50,
};

describe("certificateIdFromEvent", () => {
  it("reads the id from the payload map", () => {
    expect(certificateIdFromEvent(payloadEvent("a", BigInt(41)))).toBe("41");
  });

  it("falls back to the topic when the payload has no id", () => {
    expect(certificateIdFromEvent(topicEvent("b", BigInt(41)))).toBe("41");
  });

  it("returns undefined when no id is present", () => {
    const event = { ...topicEvent("c", BigInt(1)), topic: [xdr.ScVal.fromXDR(MINTED, "base64")] };
    expect(certificateIdFromEvent(event as unknown as rpc.Api.EventResponse)).toBeUndefined();
  });
});

describe("CertificateIndexerService.indexOnce", () => {
  it("backfills a cache row for an event that matches a job", async () => {
    const store = fakeStore();
    const service = new CertificateIndexerService(fakeRpc([topicEvent("1", BigInt(41), 100)]), store, config);

    const result = await service.indexOnce();

    expect(store.insertIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        ...JOB,
        certificateId: "41",
        stellarNetwork: "testnet",
        contractAddress: CONTRACT,
        transactionHash: "tx-1",
        ledgerSequence: 100,
        mintedAt: new Date("2026-05-01T12:00:00Z"),
      })
    );
    expect(result).toEqual({ received: 1, indexed: 1, existing: 0, skipped: 0, latestLedger: 200 });
  });

  it("reports existing cache rows without treating them as errors (idempotent replay)", async () => {
    const store = fakeStore({ insertIfMissing: jest.fn(async () => false) });
    const service = new CertificateIndexerService(fakeRpc([topicEvent("1", BigInt(41))]), store, config);

    const result = await service.indexOnce();

    expect(result).toMatchObject({ indexed: 0, existing: 1, skipped: 0 });
  });

  it("skips events with no matching verification job", async () => {
    const store = fakeStore();
    const service = new CertificateIndexerService(fakeRpc([topicEvent("2", BigInt(99))]), store, config);

    const result = await service.indexOnce();

    expect(store.insertIfMissing).not.toHaveBeenCalled();
    expect(result).toMatchObject({ indexed: 0, skipped: 1 });
  });

  it("skips events with an invalid ledger timestamp", async () => {
    const store = fakeStore();
    const event = { ...topicEvent("3", BigInt(41)), ledgerClosedAt: "not-a-date" };
    const service = new CertificateIndexerService(
      fakeRpc([event as unknown as rpc.Api.EventResponse]),
      store,
      config
    );

    const result = await service.indexOnce();

    expect(store.insertIfMissing).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
  });

  it("advances the cursor per event and to the page cursor when the page is empty", async () => {
    const store = fakeStore();
    const service = new CertificateIndexerService(
      fakeRpc([topicEvent("1", BigInt(41), 100)]),
      store,
      config
    );
    await service.indexOnce();
    expect(store.saveCursor).toHaveBeenCalledWith("token-1", 100);

    const emptyStore = fakeStore();
    const emptyService = new CertificateIndexerService(fakeRpc([], "page-end"), emptyStore, config);
    await emptyService.indexOnce();
    expect(emptyStore.saveCursor).toHaveBeenCalledWith("page-end", 200);
  });

  it("resumes from the saved cursor instead of the start ledger", async () => {
    const store = fakeStore({ getCursor: jest.fn(async () => ({ cursor: "saved" })) });
    const rpcClient = fakeRpc([]);
    const service = new CertificateIndexerService(rpcClient, store, { ...config, startLedger: 5 });

    await service.indexOnce();

    expect(rpcClient.getEvents).toHaveBeenCalledWith(expect.objectContaining({ cursor: "saved" }));
    expect(rpcClient.getEvents.mock.calls[0][0]).not.toHaveProperty("startLedger");
  });

  it("starts from the configured start ledger on the first run", async () => {
    const rpcClient = fakeRpc([]);
    const service = new CertificateIndexerService(rpcClient, fakeStore(), { ...config, startLedger: 5 });

    await service.indexOnce();

    expect(rpcClient.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5 }));
  });
});
