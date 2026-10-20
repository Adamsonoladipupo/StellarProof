import mongoose from 'mongoose';
import { runKmsRotationCycle } from '../jobs/kmsRotation.job';
import { kmsService } from '../services/kms.service';
import { env } from '../config/env';

jest.mock('../config/env', () => ({
  env: {
    KMS_ROTATION_PERIOD_DAYS: 30,
    KMS_ROTATION_BATCH_SIZE: 2,
    KMS_ROTATION_CRON_SCHEDULE: '0 * * * *',
  },
}));

jest.mock('../services/kms.service', () => ({
  kmsService: {
    deactivateExpiredKeys: jest.fn(),
    findKeysDueForRotation: jest.fn(),
    rotateKey: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const service = kmsService as unknown as Record<
  'deactivateExpiredKeys' | 'findKeysDueForRotation' | 'rotateKey',
  jest.Mock
>;
const mutableEnv = env as unknown as { KMS_ROTATION_PERIOD_DAYS: number; KMS_ROTATION_BATCH_SIZE: number };

function dueKey(): { _id: mongoose.Types.ObjectId; id: string; creatorId: mongoose.Types.ObjectId } {
  const _id = new mongoose.Types.ObjectId();
  return { _id, id: _id.toHexString(), creatorId: new mongoose.Types.ObjectId() };
}

const NOW = new Date('2026-10-20T00:00:00Z');

describe('runKmsRotationCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.KMS_ROTATION_PERIOD_DAYS = 30;
    mutableEnv.KMS_ROTATION_BATCH_SIZE = 2;
    service.deactivateExpiredKeys.mockResolvedValue(0);
    service.rotateKey.mockResolvedValue({ oldKeyVersion: 'v1', newKeyVersion: 'v2', assetsReEncrypted: 0 });
  });

  it('deactivates expired keys but rotates nothing when rotation is disabled', async () => {
    mutableEnv.KMS_ROTATION_PERIOD_DAYS = 0;
    service.deactivateExpiredKeys.mockResolvedValue(4);

    const result = await runKmsRotationCycle(NOW);

    expect(service.deactivateExpiredKeys).toHaveBeenCalledWith(NOW);
    expect(service.findKeysDueForRotation).not.toHaveBeenCalled();
    expect(result).toEqual({
      expiredDeactivated: 4,
      rotationEnabled: false,
      due: 0,
      rotated: 0,
      failed: 0,
    });
  });

  it('rotates only keys older than the period, using the cutoff derived from it', async () => {
    service.findKeysDueForRotation.mockResolvedValueOnce([]);

    await runKmsRotationCycle(NOW);

    const { cutoff } = service.findKeysDueForRotation.mock.calls[0][0];
    expect(cutoff.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('pages through due keys in batches and rotates each owner', async () => {
    const a = dueKey();
    const b = dueKey();
    const c = dueKey();
    service.findKeysDueForRotation
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([c]);

    const result = await runKmsRotationCycle(NOW);

    expect(service.findKeysDueForRotation).toHaveBeenCalledTimes(2);
    expect(service.findKeysDueForRotation.mock.calls[1][0].afterId).toEqual(b._id);
    expect(service.rotateKey.mock.calls.map(([userId]) => userId)).toEqual([
      String(a.creatorId),
      String(b.creatorId),
      String(c.creatorId),
    ]);
    expect(result).toMatchObject({ rotationEnabled: true, due: 3, rotated: 3, failed: 0 });
  });

  it('isolates a failing key so the rest of the sweep still runs', async () => {
    const a = dueKey();
    const b = dueKey();
    service.findKeysDueForRotation.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([]);
    service.rotateKey.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce({
      oldKeyVersion: 'v1',
      newKeyVersion: 'v2',
      assetsReEncrypted: 1,
    });

    const result = await runKmsRotationCycle(NOW);

    expect(service.rotateKey).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ due: 2, rotated: 1, failed: 1 });
  });

  it('skips an overlapping run while a previous sweep is still in progress', async () => {
    let finishExpiry: (value: number) => void = () => undefined;
    service.deactivateExpiredKeys.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finishExpiry = resolve;
      })
    );
    service.findKeysDueForRotation.mockResolvedValue([]);

    const first = runKmsRotationCycle(NOW);
    const second = await runKmsRotationCycle(NOW);

    expect(second).toBeNull();
    finishExpiry(0);
    await expect(first).resolves.toMatchObject({ due: 0 });
  });
});
