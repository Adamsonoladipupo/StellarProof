/**
 * ProcessedRequestService unit tests.
 *
 * The store is an in-memory map with the same unique-key and compare-and-swap
 * semantics as the MongoDB collection, so the claim rules are exercised without
 * a database.
 */
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  ProcessedRequestService,
  type ProcessedRequestRecord,
  type ProcessedRequestStore,
} from '../services/processedRequest.service';

const LEASE_MS = 10 * 60 * 1000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function memoryStore(): ProcessedRequestStore & { records: Map<string, ProcessedRequestRecord> } {
  const records = new Map<string, ProcessedRequestRecord>();
  return {
    records,
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
      if (!current || current.status !== 'processing' || current.startedAt.getTime() !== observedStartedAt.getTime()) {
        return false;
      }
      records.set(dedupKey, { ...record });
      return true;
    },
    async complete(dedupKey, jobId) {
      const current = records.get(dedupKey);
      if (current) records.set(dedupKey, { ...current, status: 'completed', jobId });
    },
    async release(dedupKey, eventId) {
      const current = records.get(dedupKey);
      if (current && current.eventId === eventId && current.status === 'processing') records.delete(dedupKey);
    },
  };
}

function buildService(store: ProcessedRequestStore, clock: { now: Date }) {
  return new ProcessedRequestService(store, () => clock.now, LEASE_MS, TTL_MS);
}

describe('ProcessedRequestService.runOnce', () => {
  it('runs the handler once and records the job for a new request', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-1' }));

    const outcome = await service.runOnce('attestation:req-1', 'evt-1', handler);

    expect(outcome).toEqual({ outcome: 'handled', jobId: 'job-1' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.records.get('attestation:req-1')).toEqual(
      expect.objectContaining({ status: 'completed', jobId: 'job-1', eventId: 'evt-1' })
    );
  });

  it('skips a request that has already been completed', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });
    await service.runOnce('attestation:req-1', 'evt-1', async () => ({ handled: true, jobId: 'job-1' }));
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-2' }));

    const outcome = await service.runOnce('attestation:req-1', 'evt-2', handler);

    expect(outcome).toEqual({ outcome: 'duplicate' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler once when two deliveries of the same request race', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });
    const handler = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { handled: true, jobId: 'job-1' };
    });

    const outcomes = await Promise.all([
      service.runOnce('attestation:req-1', 'evt-1', handler),
      service.runOnce('attestation:req-1', 'evt-1', handler),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['duplicate', 'handled']);
  });

  it('does not run a request that another worker is still processing within the lease', async () => {
    const store = memoryStore();
    const clock = { now: new Date('2026-10-19T00:00:00Z') };
    const service = buildService(store, clock);
    await store.insert({
      dedupKey: 'attestation:req-1',
      eventId: 'evt-0',
      status: 'processing',
      startedAt: new Date(clock.now.getTime() - 60_000),
      expiresAt: new Date(clock.now.getTime() + TTL_MS),
    });
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-1' }));

    const outcome = await service.runOnce('attestation:req-1', 'evt-1', handler);

    expect(outcome).toEqual({ outcome: 'duplicate' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('takes over a claim left behind by a crashed worker once the lease has expired', async () => {
    const store = memoryStore();
    const clock = { now: new Date('2026-10-19T00:00:00Z') };
    const service = buildService(store, clock);
    await store.insert({
      dedupKey: 'attestation:req-1',
      eventId: 'evt-0',
      status: 'processing',
      startedAt: new Date(clock.now.getTime() - LEASE_MS - 1),
      expiresAt: new Date(clock.now.getTime() + TTL_MS),
    });
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-1' }));

    const outcome = await service.runOnce('attestation:req-1', 'evt-1', handler);

    expect(outcome).toEqual({ outcome: 'handled', jobId: 'job-1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not take over a stale claim when another worker wins the compare-and-swap', async () => {
    const clock = { now: new Date('2026-10-19T00:00:00Z') };
    const store = memoryStore();
    const staleRecord: ProcessedRequestRecord = {
      dedupKey: 'attestation:req-1',
      eventId: 'evt-0',
      status: 'processing',
      startedAt: new Date(clock.now.getTime() - LEASE_MS - 1),
      expiresAt: new Date(clock.now.getTime() + TTL_MS),
    };
    await store.insert(staleRecord);
    store.takeOver = jest.fn(async () => false);
    const service = buildService(store, clock);
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-1' }));

    const outcome = await service.runOnce('attestation:req-1', 'evt-1', handler);

    expect(outcome).toEqual({ outcome: 'duplicate' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('releases the claim when nothing matched, so a later delivery can be processed', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });

    const first = await service.runOnce('attestation:req-1', 'evt-1', async () => ({ handled: false }));
    expect(first).toEqual({ outcome: 'unhandled' });
    expect(store.records.has('attestation:req-1')).toBe(false);

    const handler = jest.fn(async () => ({ handled: true, jobId: 'job-1' }));
    const second = await service.runOnce('attestation:req-1', 'evt-2', handler);
    expect(second).toEqual({ outcome: 'handled', jobId: 'job-1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('releases the claim and rethrows when the handler fails, so the event can be retried', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });

    await expect(
      service.runOnce('attestation:req-1', 'evt-1', async () => {
        throw new Error('mint submission failed');
      })
    ).rejects.toThrow('mint submission failed');
    expect(store.records.has('attestation:req-1')).toBe(false);

    const retry = await service.runOnce('attestation:req-1', 'evt-1', async () => ({ handled: true, jobId: 'job-1' }));
    expect(retry).toEqual({ outcome: 'handled', jobId: 'job-1' });
  });

  it('keeps distinct requests independent', async () => {
    const store = memoryStore();
    const service = buildService(store, { now: new Date('2026-10-19T00:00:00Z') });
    const handler = jest.fn(async () => ({ handled: true, jobId: 'job' }));

    await service.runOnce('attestation:req-1', 'evt-1', handler);
    await service.runOnce('attestation:req-2', 'evt-2', handler);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('stamps every claim with a TTL so records expire', async () => {
    const store = memoryStore();
    const now = new Date('2026-10-19T00:00:00Z');
    const service = buildService(store, { now });
    let seen: ProcessedRequestRecord | undefined;

    await service.runOnce('attestation:req-1', 'evt-1', async () => {
      seen = store.records.get('attestation:req-1');
      return { handled: true, jobId: 'job-1' };
    });

    expect(seen?.expiresAt.getTime()).toBe(now.getTime() + TTL_MS);
  });
});
