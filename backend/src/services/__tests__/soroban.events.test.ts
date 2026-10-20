/**
 * Soroban event parsing and RPC wrapper tests.
 *
 * Fixtures mirror `rpc.Api.EventResponse` as returned by Soroban RPC
 * `getEvents`. They are converted to the parser envelope exactly as the
 * ingestion path does, then decoded with `parseSorobanEvents`. The RPC
 * transport is a jest mock of `rpc.Server`, so the tests also assert the
 * request the wrapper sends.
 */
jest.mock('../../config/env', () => ({
  __esModule: true,
  env: {
    NODE_ENV: 'test',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_RPC_TIMEOUT_MS: 30000,
  },
}));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import crypto from 'crypto';
import { Networks, StrKey, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { SorobanService } from '../soroban.service';
import {
  parseSorobanEvents,
  SorobanEventParseError,
  type SorobanEventEnvelope,
} from '../../utils/sorobanEvents';

const ORACLE_CONTRACT_ID = StrKey.encodeContract(crypto.randomBytes(32));
const TX_HASH = 'cd'.repeat(32);

/** Builds an `rpc.Api.EventResponse` fixture for a contract event. */
function rpcEvent(
  name: string,
  payload: Record<string, unknown>,
  options: { topics?: xdr.ScVal[]; pagingToken?: string; ledger?: number } = {}
): rpc.Api.EventResponse {
  const pagingToken = options.pagingToken ?? `token-${name}`;
  return {
    id: `evt-${pagingToken}`,
    type: 'contract',
    ledger: options.ledger ?? 321,
    ledgerClosedAt: '2026-10-19T00:00:00Z',
    pagingToken,
    inSuccessfulContractCall: true,
    txHash: TX_HASH,
    topic: [xdr.ScVal.scvSymbol(name), ...(options.topics ?? [])],
    value: nativeToScVal(payload),
  } as unknown as rpc.Api.EventResponse;
}

/** Converts an RPC event into the envelope the parser consumes. */
function toEnvelope(event: rpc.Api.EventResponse): SorobanEventEnvelope {
  return {
    id: event.id,
    ledger: event.ledger,
    txHash: event.txHash,
    contractId: ORACLE_CONTRACT_ID,
    topic: event.topic,
    value: event.value,
  };
}

describe('parseSorobanEvents on RPC fixtures', () => {
  it('decodes a VerificationRequest into typed fields', () => {
    const contentHash = Buffer.alloc(32, 0x11);
    const event = rpcEvent('VerificationRequest', {
      id: 77n,
      content_hash: contentHash,
      state: 'Pending',
    });

    const [parsed] = parseSorobanEvents([toEnvelope(event)]);

    expect(parsed).toEqual(
      expect.objectContaining({
        type: 'VerificationRequest',
        eventId: event.id,
        ledger: 321,
        txHash: TX_HASH,
        contractId: ORACLE_CONTRACT_ID,
        requestId: '77',
        contentHash: contentHash.toString('hex'),
        state: 'Pending',
      })
    );
  });

  it('decodes an Attestation with its provider and TEE hash', () => {
    const provider = Buffer.alloc(32, 0x22);
    const teeHash = Buffer.alloc(32, 0x33);
    const event = rpcEvent('Attestation', {
      provider,
      tee_hash: teeHash,
      request_id: 9n,
    });

    const [parsed] = parseSorobanEvents([toEnvelope(event)]);

    expect(parsed).toEqual(
      expect.objectContaining({
        type: 'Attestation',
        requestId: '9',
        provider: provider.toString('hex'),
        teeHash: teeHash.toString('hex'),
      })
    );
  });

  it('keeps supported events and skips unknown ones in the same page', () => {
    const page = [
      rpcEvent('SomethingElse', { anything: 1n }, { pagingToken: 'p-1' }),
      rpcEvent('VerificationRequest', { id: 5n, content_hash: Buffer.alloc(32, 1) }, { pagingToken: 'p-2' }),
    ].map(toEnvelope);

    const parsed = parseSorobanEvents(page);

    expect(parsed.map((event) => event.type)).toEqual(['VerificationRequest']);
    expect(parsed[0]).toEqual(expect.objectContaining({ eventId: 'evt-p-2' }));
  });

  it('rejects a supported event whose payload is malformed', () => {
    const malformed = rpcEvent('VerificationRequest', {
      id: 1n,
      content_hash: Buffer.alloc(16, 1),
    });

    expect(() => parseSorobanEvents([toEnvelope(malformed)])).toThrow(SorobanEventParseError);
  });
});

describe('SorobanService.getEvents request formatting', () => {
  function buildService(getEvents: jest.Mock) {
    const server = { getEvents } as unknown as rpc.Server;
    return new SorobanService(
      { rpcUrl: 'https://rpc.example', networkPassphrase: Networks.TESTNET, timeoutMs: 1000, allowHttp: false },
      server
    );
  }

  it('passes the contract filter, topics, paging cursor and limit to RPC unchanged', async () => {
    const topic = xdr.ScVal.scvSymbol('VerificationRequest').toXDR('base64');
    const request: rpc.Server.GetEventsRequest = {
      filters: [{ type: 'contract', contractIds: [ORACLE_CONTRACT_ID], topics: [[topic]] }],
      limit: 25,
      cursor: 'resume-token',
    };
    const response = { latestLedger: 400, events: [rpcEvent('VerificationRequest', { id: 1n, content_hash: Buffer.alloc(32, 2) })], cursor: 'next' };
    const getEvents = jest.fn(async (_request: rpc.Server.GetEventsRequest) => response);
    const service = buildService(getEvents);

    const result = await service.getEvents(request);

    expect(getEvents).toHaveBeenCalledWith(request);
    expect(getEvents.mock.calls[0][0]).toEqual({
      filters: [{ type: 'contract', contractIds: [ORACLE_CONTRACT_ID], topics: [[topic]] }],
      limit: 25,
      cursor: 'resume-token',
    });
    expect(result).toBe(response);
  });

  it('sends topics as base64 ScVal XDR that decodes back to the requested symbol', async () => {
    const topic = xdr.ScVal.scvSymbol('Attestation').toXDR('base64');
    const getEvents = jest.fn(async (_request: rpc.Server.GetEventsRequest) => ({
      latestLedger: 1,
      events: [],
      cursor: '',
    }));
    const service = buildService(getEvents);

    await service.getEvents({
      filters: [{ type: 'contract', contractIds: [ORACLE_CONTRACT_ID], topics: [[topic]] }],
      startLedger: 100,
      limit: 10,
    });

    const sent = getEvents.mock.calls[0][0];
    const decoded = xdr.ScVal.fromXDR(sent.filters![0].topics![0][0], 'base64');
    expect(decoded.sym().toString()).toBe('Attestation');
    expect(sent.startLedger).toBe(100);
  });
});
