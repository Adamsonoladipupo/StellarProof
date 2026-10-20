import crypto from "crypto";
import { nativeToScVal, scValToNative, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import {
  createVerificationEventSubscriber,
  EventIngestionService,
} from "../services/eventIngestion.service";
import {
  ProcessedRequestService,
  type ProcessedRequestRecord,
  type ProcessedRequestStore,
} from "../services/processedRequest.service";
import type {
  IngestedSorobanEvent,
  SorobanEventBus,
} from "../services/sorobanEventBus.service";
import { VerificationJobModel } from "../models/verificationJob.model";
import { verificationService } from "../services/verification.service";
import { VerificationStatus } from "../types/verification.types";

const contractId = (): string => StrKey.encodeContract(crypto.randomBytes(32));
const hash = (): string => crypto.randomBytes(32).toString("hex");

function event(
  name: "VerificationRequest" | "attestation" | "CertificateMinted",
  payload: Record<string, unknown>,
  pagingToken: string
): rpc.Api.EventResponse {
  return {
    id: `evt-${pagingToken}`,
    type: "contract",
    ledger: 200,
    ledgerClosedAt: new Date().toISOString(),
    pagingToken,
    inSuccessfulContractCall: true,
    txHash: hash(),
    topic: [xdr.ScVal.scvSymbol(name)],
    value: nativeToScVal(payload),
  } as unknown as rpc.Api.EventResponse;
}

/** In-memory stand-in for the processed-request collection, with the same unique-key semantics. */
function memoryProcessedStore(): ProcessedRequestStore {
  const records = new Map<string, ProcessedRequestRecord>();
  return {
    async insert(record) {
      if (records.has(record.dedupKey)) return false;
      records.set(record.dedupKey, { ...record });
      return true;
    },
    async find(dedupKey) {
      return records.get(dedupKey) ?? null;
    },
    async takeOver(dedupKey, observedStartedAt, record) {
      const current = records.get(dedupKey);
      if (!current || current.status !== "processing" || current.startedAt.getTime() !== observedStartedAt.getTime()) {
        return false;
      }
      records.set(dedupKey, { ...record });
      return true;
    },
    async complete(dedupKey, jobId) {
      const current = records.get(dedupKey);
      if (current) records.set(dedupKey, { ...current, status: "completed", jobId });
    },
    async release(dedupKey, eventId) {
      const current = records.get(dedupKey);
      if (current && current.eventId === eventId && current.status === "processing") records.delete(dedupKey);
    },
  };
}

describe("EventIngestionService", () => {
  afterEach(() => jest.restoreAllMocks());

  function harness(events: rpc.Api.EventResponse[]) {
    const oracleContractId = contractId();
    const provenanceContractId = contractId();
    const registryContractId = contractId();

    /** Each event is served only by the contract that emits it. */
    const contractFor = (chainEvent: rpc.Api.EventResponse): string => {
      const name = String(scValToNative(chainEvent.topic[0]));
      if (name === "CertificateMinted") return provenanceContractId;
      if (name === "registry") return registryContractId;
      return oracleContractId;
    };

    const rpcClient = {
      getEvents: jest.fn(async (request: rpc.Server.GetEventsRequest) => {
        const ids = request.filters?.[0]?.contractIds ?? [];
        return {
          latestLedger: 205,
          events: events.filter((chainEvent) => ids.includes(contractFor(chainEvent))),
          cursor: "page-end",
        };
      }),
    };
    const jobs = {
      advanceFromAttestationEvent: jest.fn(async (_input: unknown) => ({ _id: "job-1" })),
      completeFromMintEvent: jest.fn(async (_input: unknown) => ({ _id: "job-1" })),
    };
    const cursors = {
      get: jest.fn(async (_contractId: string): Promise<{ cursor: string; latestLedger: number } | null> => null),
      save: jest.fn(async (_contractId: string, _cursor: string, _latestLedger: number) => undefined),
    };
    const minter = { mintForJob: jest.fn(async (_jobId: string) => ({ certificateId: "1" })) };
    const processed = new ProcessedRequestService(memoryProcessedStore());
    const subscriber = createVerificationEventSubscriber({
      processed,
      jobs: jobs as never,
      minter,
    });
    const published: IngestedSorobanEvent[] = [];
    const bus: SorobanEventBus & { publish: jest.Mock } = {
      subscribe: jest.fn(() => () => undefined),
      publish: jest.fn(async (publishedEvent: IngestedSorobanEvent) => {
        published.push(publishedEvent);
        return (await subscriber(publishedEvent)) === true ? 1 : 0;
      }),
    };
    const service = new EventIngestionService(
      rpcClient,
      jobs as never,
      cursors,
      {
        oracleContractId,
        provenanceContractId,
        registryContractId,
        startLedger: 100,
        limit: 50,
      },
      minter,
      bus
    );
    return {
      service,
      rpcClient,
      jobs,
      cursors,
      minter,
      bus,
      published,
      oracleContractId,
      provenanceContractId,
      registryContractId,
    };
  }

  it("filters contract events and advances a correlated job to minting", async () => {
    const manifestHash = hash();
    const attestationHash = hash();
    const chainEvent = event(
      "attestation",
      { manifest_hash: manifestHash, request_id: "request-7", attestation_hash: attestationHash },
      "200-1"
    );
    const h = harness([chainEvent]);

    await expect(h.service.ingestOnce()).resolves.toMatchObject({ matched: 1, correlated: 1 });

    const requests = h.rpcClient.getEvents.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      filters: [
        {
          type: "contract",
          contractIds: [h.oracleContractId],
          topics: [
            [xdr.ScVal.scvSymbol("VerificationRequest").toXDR("base64")],
            [xdr.ScVal.scvSymbol("Attestation").toXDR("base64")],
            [xdr.ScVal.scvSymbol("Attested").toXDR("base64")],
          ],
        },
      ],
      limit: 50,
      startLedger: 100,
    });
    expect(requests[1]).toEqual({
      filters: [
        {
          type: "contract",
          contractIds: [h.provenanceContractId],
          topics: [[xdr.ScVal.scvSymbol("CertificateMinted").toXDR("base64")]],
        },
      ],
      limit: 50,
      startLedger: 100,
    });
    expect(requests[2]).toEqual({
      filters: [
        {
          type: "contract",
          contractIds: [h.registryContractId],
          topics: [
            [
              xdr.ScVal.scvSymbol("registry").toXDR("base64"),
              xdr.ScVal.scvSymbol("TeeHashAdded").toXDR("base64"),
            ],
            [
              xdr.ScVal.scvSymbol("registry").toXDR("base64"),
              xdr.ScVal.scvSymbol("TeeHashRemoved").toXDR("base64"),
            ],
            [
              xdr.ScVal.scvSymbol("registry").toXDR("base64"),
              xdr.ScVal.scvSymbol("ProviderAdded").toXDR("base64"),
            ],
            [
              xdr.ScVal.scvSymbol("registry").toXDR("base64"),
              xdr.ScVal.scvSymbol("ProviderRemoved").toXDR("base64"),
            ],
          ],
        },
      ],
      limit: 50,
      startLedger: 100,
    });
    expect(h.jobs.advanceFromAttestationEvent).toHaveBeenCalledWith({
      manifestHash,
      requestId: "request-7",
      attestationHash,
      transactionHash: chainEvent.txHash,
    });
    expect(h.cursors.save).toHaveBeenCalledWith(h.oracleContractId, "200-1", 200);
    expect(h.minter.mintForJob).toHaveBeenCalledWith("job-1");
  });

  it("publishes VerificationRequest without fabricating a job transition", async () => {
    const contentHash = hash();
    const chainEvent = event(
      "VerificationRequest",
      { id: 7n, content_hash: contentHash, state: "Pending" },
      "200-vr"
    );
    const h = harness([chainEvent]);

    await expect(h.service.ingestOnce()).resolves.toMatchObject({
      matched: 1,
      correlated: 0,
    });

    expect(h.published).toEqual([
      expect.objectContaining({
        kind: "verificationRequest",
        eventId: chainEvent.id,
        requestId: "7",
        contentHash,
        state: "Pending",
      }),
    ]);
    expect(h.jobs.advanceFromAttestationEvent).not.toHaveBeenCalled();
    expect(h.jobs.completeFromMintEvent).not.toHaveBeenCalled();
    expect(h.minter.mintForJob).not.toHaveBeenCalled();
    expect(h.cursors.save).toHaveBeenCalledWith(h.oracleContractId, "200-vr", 200);
  });

  it("records CertificateMinted results and resumes from the durable cursor", async () => {
    const manifestHash = hash();
    const chainEvent = event("CertificateMinted", {}, "200-2");
    chainEvent.topic.push(
      xdr.ScVal.scvU64(new xdr.Uint64(BigInt(91))),
      xdr.ScVal.scvString(manifestHash)
    );
    chainEvent.value = xdr.ScVal.scvVoid();
    const h = harness([chainEvent]);
    h.cursors.get.mockResolvedValue({ cursor: "199-9", latestLedger: 199 });

    await h.service.ingestOnce();

    expect(h.rpcClient.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "199-9" })
    );
    expect(h.jobs.completeFromMintEvent).toHaveBeenCalledWith({
      manifestHash,
      requestId: undefined,
      certificateId: "91",
      transactionHash: chainEvent.txHash,
    });
    expect(h.minter.mintForJob).not.toHaveBeenCalled();
  });

  it("advances an empty page cursor without fabricating job data", async () => {
    const h = harness([]);
    await expect(h.service.ingestOnce()).resolves.toMatchObject({ received: 0, matched: 0 });
    expect(h.cursors.save).toHaveBeenCalledWith(h.oracleContractId, "page-end", 205);
    expect(h.jobs.advanceFromAttestationEvent).not.toHaveBeenCalled();
  });

  it("resumes each contract from its own cursor", async () => {
    const h = harness([]);
    h.cursors.get.mockImplementation(async (id: string) =>
      id === h.oracleContractId ? { cursor: "oracle-7", latestLedger: 150 } : null
    );

    await h.service.ingestOnce();

    const requests = h.rpcClient.getEvents.mock.calls.map(([request]) => request);
    const oracleRequest = requests.find((r) => r.filters?.[0]?.contractIds?.[0] === h.oracleContractId);
    const provenanceRequest = requests.find(
      (r) => r.filters?.[0]?.contractIds?.[0] === h.provenanceContractId
    );
    expect(oracleRequest).toEqual(expect.objectContaining({ cursor: "oracle-7" }));
    expect(oracleRequest?.startLedger).toBeUndefined();
    expect(provenanceRequest).toEqual(expect.objectContaining({ startLedger: 100 }));
    expect(provenanceRequest?.cursor).toBeUndefined();
  });

  it("saves each contract cursor once, after its whole batch has been handled", async () => {
    const first = event(
      "attestation",
      { manifest_hash: hash(), request_id: "request-a", attestation_hash: hash() },
      "200-a"
    );
    const second = event(
      "attestation",
      { manifest_hash: hash(), request_id: "request-b", attestation_hash: hash() },
      "201-b"
    );
    const h = harness([first, second]);

    await h.service.ingestOnce();

    const oracleSaves = h.cursors.save.mock.calls.filter(([id]) => id === h.oracleContractId);
    expect(oracleSaves).toEqual([[h.oracleContractId, "201-b", 200]]);
    const lastPublish = Math.max(...h.bus.publish.mock.invocationCallOrder);
    const oracleSaveOrder = h.cursors.save.mock.invocationCallOrder[
      h.cursors.save.mock.calls.findIndex(([id]) => id === h.oracleContractId)
    ];
    expect(oracleSaveOrder).toBeGreaterThan(lastPublish);
  });

  it("leaves the cursor in place when a handler fails mid-batch", async () => {
    const first = event(
      "attestation",
      { manifest_hash: hash(), request_id: "request-a", attestation_hash: hash() },
      "200-a"
    );
    const second = event(
      "attestation",
      { manifest_hash: hash(), request_id: "request-b", attestation_hash: hash() },
      "201-b"
    );
    const h = harness([first, second]);
    h.jobs.advanceFromAttestationEvent
      .mockResolvedValueOnce({ _id: "job-1" })
      .mockRejectedValueOnce(new Error("db unavailable"));

    await expect(h.service.ingestOnce()).rejects.toThrow("db unavailable");
    expect(h.cursors.save.mock.calls.some(([id]) => id === h.oracleContractId)).toBe(false);
  });

  it("does not reprocess a request when a batch replays after a crash before the cursor was saved", async () => {
    const chainEvent = event(
      "attestation",
      { manifest_hash: hash(), request_id: "request-replay", attestation_hash: hash() },
      "200-replay"
    );
    const h = harness([chainEvent]);

    // The cursor is never read back, as if the worker crashed before saving it.
    await h.service.ingestOnce();
    await h.service.ingestOnce();

    expect(h.jobs.advanceFromAttestationEvent).toHaveBeenCalledTimes(1);
    expect(h.minter.mintForJob).toHaveBeenCalledTimes(1);
  });

  it("persists the attestation event transition idempotently", async () => {
    const job = {
      status: VerificationStatus.TEE_VERIFYING,
      timeline: [] as unknown[],
      attestationTransactionHash: undefined as string | undefined,
      teeAttestationHash: undefined as string | undefined,
      save: jest.fn(async () => undefined),
      toObject: jest.fn(function (this: unknown) { return this; }),
    };
    jest.spyOn(VerificationJobModel, "findOne").mockResolvedValue(job as never);

    const transactionHash = hash();
    const attestationHash = hash();
    await verificationService.advanceFromAttestationEvent({
      manifestHash: hash(),
      transactionHash,
      attestationHash,
    });

    expect(job.status).toBe(VerificationStatus.MINTING);
    expect(job.attestationTransactionHash).toBe(transactionHash);
    expect(job.teeAttestationHash).toBe(attestationHash);
    expect(job.save).toHaveBeenCalledTimes(1);
  });

  it("persists certificate completion from a correlated mint event", async () => {
    const job = {
      status: VerificationStatus.MINTING,
      timeline: [] as unknown[],
      stellarTransactionHash: undefined as string | undefined,
      certificateId: undefined as string | undefined,
      save: jest.fn(async () => undefined),
      toObject: jest.fn(function (this: unknown) { return this; }),
    };
    jest.spyOn(VerificationJobModel, "findOne").mockResolvedValue(job as never);

    await verificationService.completeFromMintEvent({
      requestId: "request-9",
      certificateId: "12",
      transactionHash: hash(),
    });

    expect(job.status).toBe(VerificationStatus.COMPLETED);
    expect(job.certificateId).toBe("12");
    expect(job.save).toHaveBeenCalledTimes(1);
  });
});
