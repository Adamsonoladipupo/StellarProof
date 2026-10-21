/**
 * Verification job state machine: every valid transition, every illegal
 * transition, the per-target required-field guards and terminal-state
 * immutability (issue #736).
 *
 * Real MongoDB:  mongodb-memory-server. Jobs are persisted and re-read, so
 *                each assertion checks what was actually stored.
 * Side effects:  the status stream and webhook dispatcher are replaced with
 *                jest.fn() (no sockets or outbound HTTP); the IPFS client is
 *                stubbed because the state machine never fetches content.
 */
jest.mock("../ipfs.service", () => ({ ipfsService: { fetchManifestJson: jest.fn() } }));
jest.mock("../statusStream.service", () => ({
  statusStreamService: { broadcast: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../webhook.service", () => ({
  webhookService: { dispatchJobEvent: jest.fn().mockResolvedValue(true) },
}));

import crypto from "crypto";
import mongoose from "mongoose";
import { Keypair } from "@stellar/stellar-sdk";
import { MongoMemoryServer } from "mongodb-memory-server";

import { verificationService } from "../verification.service";
import { statusStreamService } from "../statusStream.service";
import { VerificationJobModel } from "../../models/verificationJob.model";
import { AppError } from "../../errors/AppError";
import { VerificationStateError } from "../../errors/VerificationStateError";
import {
  VALID_TRANSITIONS,
  VerificationStatus,
  type UpdateVerificationStatusDTO,
} from "../../types/verification.types";

const ALL_STATUSES = Object.values(VerificationStatus);
const TERMINAL_STATUSES = ALL_STATUSES.filter((status) => VALID_TRANSITIONS[status].size === 0);
const NON_TERMINAL_STATUSES = ALL_STATUSES.filter((status) => VALID_TRANSITIONS[status].size > 0);

type Transition = [from: VerificationStatus, to: VerificationStatus];

const VALID_PAIRS: Transition[] = ALL_STATUSES.flatMap((from) =>
  [...VALID_TRANSITIONS[from]].map((to): Transition => [from, to])
);
const ILLEGAL_PAIRS: Transition[] = NON_TERMINAL_STATUSES.flatMap((from) =>
  ALL_STATUSES.filter((to) => !VALID_TRANSITIONS[from].has(to)).map((to): Transition => [from, to])
);

const hex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");

/** Fields the service requires when entering `target`, with fresh values per call. */
function requiredFieldsFor(target: VerificationStatus): Omit<UpdateVerificationStatusDTO, "status"> {
  switch (target) {
    case VerificationStatus.TEE_VERIFYING:
      return { teeAttestationHash: hex(32), teeSignature: hex(64), codeMeasurementHash: hex(32) };
    case VerificationStatus.MINTING:
      return { stellarTransactionHash: hex(32) };
    case VerificationStatus.FAILED:
      return { errorMessage: `SPV verification rejected request ${hex(4)}` };
    default:
      return {};
  }
}

/** Every optional field, so illegal transitions are never rejected for a missing field. */
function allFields(target: VerificationStatus): UpdateVerificationStatusDTO {
  return {
    status: target,
    ...requiredFieldsFor(VerificationStatus.TEE_VERIFYING),
    ...requiredFieldsFor(VerificationStatus.MINTING),
    ...requiredFieldsFor(VerificationStatus.FAILED),
    certificateId: String(crypto.randomInt(1, 1_000_000)),
  };
}

/** Persists a job already in `status`, with the fields that state implies. */
async function storeJob(status: VerificationStatus): Promise<string> {
  const now = new Date();
  const job = await VerificationJobModel.create({
    ownerPublicKey: Keypair.random().publicKey(),
    contentHash: hex(32),
    manifestHash: hex(32),
    requestId: new mongoose.Types.ObjectId().toString(),
    status,
    timeline: [{ stage: status, at: now, actor: "worker" }],
    ...(status === VerificationStatus.COMPLETED
      ? { stellarTransactionHash: hex(32), certificateId: String(crypto.randomInt(1, 1_000_000)) }
      : {}),
    ...(status === VerificationStatus.FAILED ? { errorMessage: "verification failed" } : {}),
  });
  return String(job._id);
}

/** The stored document as plain JSON, used to prove a rejected call changed nothing. */
async function snapshot(id: string): Promise<Record<string, unknown>> {
  const doc = await VerificationJobModel.findById(id).lean();
  if (!doc) throw new Error(`job ${id} disappeared`);
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err
  );
}

const broadcast = statusStreamService.broadcast as jest.Mock;

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await VerificationJobModel.init();
});

afterEach(async () => {
  await VerificationJobModel.deleteMany({});
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("VALID_TRANSITIONS", () => {
  it("defines the transitions of every status", () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("has exactly two terminal states, completed and failed", () => {
    expect(TERMINAL_STATUSES.sort()).toEqual(
      [VerificationStatus.COMPLETED, VerificationStatus.FAILED].sort()
    );
  });

  it("lets every non-terminal state fail", () => {
    for (const status of NON_TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[status].has(VerificationStatus.FAILED)).toBe(true);
    }
  });
});

describe("updateJobStatus: valid transitions", () => {
  it.each(VALID_PAIRS)("moves a job from %s to %s and persists it", async (from, to) => {
    const id = await storeJob(from);
    const fields = requiredFieldsFor(to);

    const result = await verificationService.updateJobStatus(id, { status: to, ...fields });

    expect(result.status).toBe(to);
    const stored = await VerificationJobModel.findById(id).lean();
    expect(stored?.status).toBe(to);
    expect(stored).toMatchObject(fields);
    expect(stored?.timeline.map((entry) => entry.stage)).toEqual([from, to]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(id, to, expect.any(Object));
  });

  it("walks the full success path and records every stage in order", async () => {
    const id = await storeJob(VerificationStatus.PENDING);
    const path = [
      VerificationStatus.PROCESSING,
      VerificationStatus.TEE_VERIFYING,
      VerificationStatus.MINTING,
      VerificationStatus.COMPLETED,
    ];

    for (const next of path) {
      await verificationService.updateJobStatus(id, { status: next, ...requiredFieldsFor(next) });
    }

    const stored = await VerificationJobModel.findById(id).lean();
    expect(stored?.status).toBe(VerificationStatus.COMPLETED);
    expect(stored?.timeline.map((entry) => entry.stage)).toEqual([VerificationStatus.PENDING, ...path]);
  });

  it("records the actor that drove the transition", async () => {
    const id = await storeJob(VerificationStatus.PENDING);

    await verificationService.updateJobStatus(id, { status: VerificationStatus.PROCESSING }, "oracle");

    const stored = await VerificationJobModel.findById(id).lean();
    expect(stored?.timeline.at(-1)?.actor).toBe("oracle");
  });
});

describe("updateJobStatus: illegal transitions", () => {
  it.each(ILLEGAL_PAIRS)("rejects %s -> %s and leaves the job untouched", async (from, to) => {
    const id = await storeJob(from);
    const before = await snapshot(id);

    const err = await rejection(verificationService.updateJobStatus(id, allFields(to)));

    expect(err).toBeInstanceOf(VerificationStateError);
    expect(err).toMatchObject({
      statusCode: 409,
      code: "INVALID_STATE_TRANSITION",
      fromStatus: from,
      toStatus: to,
    });
    expect(await snapshot(id)).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("checks legality before required fields", async () => {
    const id = await storeJob(VerificationStatus.PENDING);

    const err = await rejection(
      verificationService.updateJobStatus(id, { status: VerificationStatus.MINTING })
    );

    expect(err).toBeInstanceOf(VerificationStateError);
  });
});

describe("updateJobStatus: required-field guards", () => {
  const teeFields = ["teeAttestationHash", "teeSignature", "codeMeasurementHash"] as const;

  it.each(teeFields)("rejects entering tee_verifying without %s", async (missing) => {
    const id = await storeJob(VerificationStatus.PROCESSING);
    const before = await snapshot(id);
    const fields = requiredFieldsFor(VerificationStatus.TEE_VERIFYING);
    delete fields[missing];

    const err = await rejection(
      verificationService.updateJobStatus(id, { status: VerificationStatus.TEE_VERIFYING, ...fields })
    );

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 409, code: "MISSING_TEE_FIELDS" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("rejects entering minting without stellarTransactionHash", async () => {
    const id = await storeJob(VerificationStatus.TEE_VERIFYING);
    const before = await snapshot(id);

    const err = await rejection(
      verificationService.updateJobStatus(id, { status: VerificationStatus.MINTING })
    );

    expect(err).toMatchObject({ statusCode: 409, code: "MISSING_TRANSACTION_HASH" });
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(NON_TERMINAL_STATUSES)("rejects failing a %s job without errorMessage", async (from) => {
    const id = await storeJob(from);
    const before = await snapshot(id);

    const err = await rejection(
      verificationService.updateJobStatus(id, { status: VerificationStatus.FAILED })
    );

    expect(err).toMatchObject({ statusCode: 409, code: "MISSING_ERROR_MESSAGE" });
    expect(await snapshot(id)).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("terminal states are immutable", () => {
  const terminalTargets: Transition[] = TERMINAL_STATUSES.flatMap((from) =>
    ALL_STATUSES.map((to): Transition => [from, to])
  );

  it.each(terminalTargets)("a %s job cannot move to %s", async (from, to) => {
    const id = await storeJob(from);
    const before = await snapshot(id);

    const err = await rejection(verificationService.updateJobStatus(id, allFields(to)));

    expect(err).toBeInstanceOf(VerificationStateError);
    expect(await snapshot(id)).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(TERMINAL_STATUSES)("an oracle attestation cannot reopen a %s job", async (status) => {
    const id = await storeJob(status);
    const before = await snapshot(id);

    const err = await rejection(
      verificationService.receiveOracleAttestation({
        jobId: id,
        teeAttestationHash: hex(32),
        teeSignature: hex(64),
      })
    );

    expect(err).toBeInstanceOf(VerificationStateError);
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(TERMINAL_STATUSES)("contract events do not change a %s job", async (status) => {
    const id = await storeJob(status);
    const stored = await VerificationJobModel.findById(id).lean();
    const before = await snapshot(id);

    await verificationService.advanceFromAttestationEvent({
      manifestHash: stored?.manifestHash,
      transactionHash: hex(32),
      attestationHash: hex(32),
    });
    await verificationService.completeFromMintEvent({
      manifestHash: stored?.manifestHash,
      certificateId: String(crypto.randomInt(1, 1_000_000)),
      transactionHash: hex(32),
    });

    expect(await snapshot(id)).toEqual(before);
  });

  it.each(TERMINAL_STATUSES)("the timeout sweep leaves a stale %s job alone", async (status) => {
    const id = await storeJob(status);
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await VerificationJobModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { updatedAt: longAgo } }
    );
    const before = await snapshot(id);

    const failed = await verificationService.failStaleJobs(new Date());

    expect(failed).toBe(0);
    expect(await snapshot(id)).toEqual(before);
  });
});

describe("receiveOracleAttestation", () => {
  it("moves a tee_verifying job to minting", async () => {
    const id = await storeJob(VerificationStatus.TEE_VERIFYING);
    const teeAttestationHash = hex(32);

    const result = await verificationService.receiveOracleAttestation({
      jobId: id,
      teeAttestationHash,
      teeSignature: hex(64),
    });

    expect(result.status).toBe(VerificationStatus.MINTING);
    const stored = await VerificationJobModel.findById(id).lean();
    expect(stored).toMatchObject({ status: VerificationStatus.MINTING, teeAttestationHash });
    expect(stored?.timeline.at(-1)).toMatchObject({ stage: VerificationStatus.MINTING, actor: "oracle" });
  });

  it.each(ALL_STATUSES.filter((status) => !VALID_TRANSITIONS[status].has(VerificationStatus.MINTING)))(
    "rejects an attestation for a %s job",
    async (status) => {
      const id = await storeJob(status);
      const before = await snapshot(id);

      const err = await rejection(
        verificationService.receiveOracleAttestation({
          jobId: id,
          teeAttestationHash: hex(32),
          teeSignature: hex(64),
        })
      );

      expect(err).toBeInstanceOf(VerificationStateError);
      expect(await snapshot(id)).toEqual(before);
    }
  );
});

describe("job lookup guards", () => {
  it("rejects a malformed job id with 400", async () => {
    const err = await rejection(
      verificationService.updateJobStatus("not-an-object-id", { status: VerificationStatus.PROCESSING })
    );
    expect(err).toMatchObject({ statusCode: 400, code: "INVALID_ID" });
  });

  it("rejects an unknown job id with 404", async () => {
    const err = await rejection(
      verificationService.updateJobStatus(new mongoose.Types.ObjectId().toString(), {
        status: VerificationStatus.PROCESSING,
      })
    );
    expect(err).toMatchObject({ statusCode: 404, code: "JOB_NOT_FOUND" });
  });
});
