import mongoose from "mongoose";
import { AccessControlService, type NftOwnershipChecker } from "../services/accessControl.service";
import { AppError } from "../errors/AppError";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const HOLDER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const ownerId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();

function service(checker: NftOwnershipChecker = jest.fn().mockResolvedValue(false)) {
  return { svc: new AccessControlService(checker), checker };
}

async function expectDenied(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error("expected access to be denied");
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).statusCode).toBe(status);
}

describe("AccessControlService.assertCanUnseal", () => {
  it("allows the owner on a private record", async () => {
    const { svc } = service();
    await expect(
      svc.assertCanUnseal({ accessType: "private" }, { userId: ownerId, ownerId })
    ).resolves.toBeUndefined();
  });

  it("denies a non-owner on a private record", async () => {
    const { svc } = service();
    await expectDenied(
      svc.assertCanUnseal({ accessType: "private" }, { userId: otherId, ownerId }),
      "PRIVATE_ACCESS_ONLY",
      403
    );
  });

  it("allows a listed user on a specific_users record", async () => {
    const { svc } = service();
    await expect(
      svc.assertCanUnseal(
        { accessType: "specific_users", allowedUsers: [otherId] },
        { userId: otherId, ownerId }
      )
    ).resolves.toBeUndefined();
  });

  it("denies an unlisted user on a specific_users record", async () => {
    const { svc } = service();
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "specific_users", allowedUsers: [] },
        { userId: otherId, ownerId }
      ),
      "NOT_ALLOWED_USER",
      403
    );
  });

  it("allows any authenticated requester on public_with_conditions", async () => {
    const { svc } = service();
    await expect(
      svc.assertCanUnseal({ accessType: "public_with_conditions" }, { userId: otherId, ownerId })
    ).resolves.toBeUndefined();
  });

  it("allows an NFT holder on nft_holders_only", async () => {
    const checker = jest.fn().mockResolvedValue(true);
    const { svc } = service(checker);
    await expect(
      svc.assertCanUnseal(
        { accessType: "nft_holders_only", nftContractAddress: CONTRACT },
        { userId: otherId, ownerId, stellarPublicKey: HOLDER }
      )
    ).resolves.toBeUndefined();
    expect(checker).toHaveBeenCalledWith(CONTRACT, HOLDER);
  });

  it("denies a non-holder on nft_holders_only", async () => {
    const { svc } = service(jest.fn().mockResolvedValue(false));
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "nft_holders_only", nftContractAddress: CONTRACT },
        { userId: otherId, ownerId, stellarPublicKey: HOLDER }
      ),
      "NFT_NOT_HELD",
      403
    );
  });

  it("denies nft_holders_only when the requester has no linked wallet", async () => {
    const checker = jest.fn();
    const { svc } = service(checker);
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "nft_holders_only", nftContractAddress: CONTRACT },
        { userId: otherId, ownerId, stellarPublicKey: null }
      ),
      "WALLET_NOT_LINKED",
      403
    );
    expect(checker).not.toHaveBeenCalled();
  });

  it("fails closed with 502 when the ownership lookup throws", async () => {
    const { svc } = service(jest.fn().mockRejectedValue(new Error("rpc down")));
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "nft_holders_only", nftContractAddress: CONTRACT },
        { userId: otherId, ownerId, stellarPublicKey: HOLDER }
      ),
      "NFT_CHECK_FAILED",
      502
    );
  });

  it("rejects nft_holders_only records that have no contract address", async () => {
    const { svc } = service();
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "nft_holders_only", nftContractAddress: null },
        { userId: otherId, ownerId, stellarPublicKey: HOLDER }
      ),
      "ACCESS_POLICY_INVALID",
      500
    );
  });

  it("denies unknown access types instead of defaulting open", async () => {
    const { svc } = service();
    await expectDenied(
      svc.assertCanUnseal(
        { accessType: "legacy_open" as never },
        { userId: otherId, ownerId }
      ),
      "ACCESS_POLICY_INVALID",
      500
    );
  });
});
