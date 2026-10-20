/**
 * SorobanService.simulateContractCall unit tests.
 *
 * The RPC transport is a stub `rpc.Server`; transactions and XDR are real SDK
 * objects so the decoding and fee arithmetic are exercised for real.
 */
jest.mock('../config/env', () => ({
  __esModule: true,
  env: {
    NODE_ENV: 'test',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_RPC_TIMEOUT_MS: 30000,
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import crypto from 'crypto';
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { AppError } from '../errors/AppError';
import { SorobanService } from '../services/soroban.service';

const source = Keypair.random();

function invokeHostFunction(functionName = 'mint'): xdr.HostFunction {
  const contractId = StrKey.encodeContract(crypto.randomBytes(32));
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
      functionName,
      args: [],
    })
  );
}

function buildTransaction(fee: string, operationCount = 1): Transaction {
  const builder = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee,
    networkPassphrase: Networks.TESTNET,
  });
  for (let i = 0; i < operationCount; i += 1) {
    builder.addOperation(Operation.invokeHostFunction({ func: invokeHostFunction(), auth: [] }));
  }
  return builder.setTimeout(30).build();
}

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    latestLedger: 500,
    events: [],
    transactionData: {},
    minResourceFee: '1000',
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
    ...overrides,
  };
}

function buildService(simulateTransaction: jest.Mock) {
  const server = { simulateTransaction } as unknown as rpc.Server;
  return new SorobanService(
    { rpcUrl: 'https://rpc.example', networkPassphrase: Networks.TESTNET, timeoutMs: 1000, allowHttp: false },
    server
  );
}

async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
}

describe('simulateContractCall', () => {
  it('reports a ready transaction when the fee covers resource and inclusion fees', async () => {
    const simulateTransaction = jest.fn(async () => successResponse());
    const service = buildService(simulateTransaction);

    const result = await service.simulateContractCall(buildTransaction('2000'));

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      latestLedger: 500,
      restoreRequired: false,
      minResourceFee: '1000',
      requiredFee: String(1000 + Number(BASE_FEE)),
      submittedFee: '2000',
      feeSufficient: true,
      authEntryCount: 0,
      authorizationRequired: false,
      readyToSubmit: true,
    });
  });

  it('flags a transaction whose fee is below the simulated requirement', async () => {
    const service = buildService(jest.fn(async () => successResponse({ minResourceFee: '5000' })));

    const result = await service.simulateContractCall(buildTransaction(BASE_FEE));

    expect(result.feeSufficient).toBe(false);
    expect(result.readyToSubmit).toBe(false);
    expect(result.requiredFee).toBe(String(5000 + Number(BASE_FEE)));
  });

  it('rejects a transaction with more than one operation without calling RPC', async () => {
    const simulateTransaction = jest.fn();
    const service = buildService(simulateTransaction);

    await expectAppError(
      service.simulateContractCall(buildTransaction('2000', 2)),
      400,
      'NOT_A_CONTRACT_CALL'
    );
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it('reports the authorization entries the invocation requires', async () => {
    const authEntry = {} as xdr.SorobanAuthorizationEntry;
    const service = buildService(
      jest.fn(async () => successResponse({ result: { auth: [authEntry], retval: xdr.ScVal.scvVoid() } }))
    );

    const result = await service.simulateContractCall(buildTransaction('2000'));

    expect(result.authEntryCount).toBe(1);
    expect(result.authorizationRequired).toBe(true);
    expect(result.readyToSubmit).toBe(true);
  });

  it('marks a restore-required simulation as not ready to submit', async () => {
    const service = buildService(
      jest.fn(async () =>
        successResponse({
          restorePreamble: { minResourceFee: '300', transactionData: {} },
        })
      )
    );

    const result = await service.simulateContractCall(buildTransaction('2000'));

    expect(result.restoreRequired).toBe(true);
    expect(result.readyToSubmit).toBe(false);
  });

  it('rejects malformed transaction XDR without calling RPC', async () => {
    const simulateTransaction = jest.fn();
    const service = buildService(simulateTransaction);
    const malformed = { toXDR: () => 'not-valid-xdr', fee: '100' } as unknown as Transaction;

    await expectAppError(service.simulateContractCall(malformed), 400, 'MALFORMED_TRANSACTION_XDR');
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it('rejects transactions that are not a single contract invocation without calling RPC', async () => {
    const simulateTransaction = jest.fn();
    const service = buildService(simulateTransaction);
    const payment = new TransactionBuilder(new Account(source.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
      .setTimeout(30)
      .build();

    await expectAppError(service.simulateContractCall(payment), 400, 'NOT_A_CONTRACT_CALL');
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it('surfaces simulation failures such as contract traps as 422', async () => {
    const service = buildService(
      jest.fn(async () => ({ latestLedger: 500, events: [], error: 'HostError: trap' }))
    );

    await expectAppError(service.simulateContractCall(buildTransaction('2000')), 422, 'SOROBAN_SIMULATION_FAILED');
  });
});
