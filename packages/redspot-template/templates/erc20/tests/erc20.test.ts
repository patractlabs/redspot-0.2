import BN from "bn.js";
import { expect } from "chai";
import { patract, network, artifacts } from "redspot";

const { getContractFactory, getRandomSigner } = patract;

const { api, getSigners } = network;

describe("ERC20", () => {
  after(() => {
    return api.disconnect();
  });

  async function setup() {
    const one = new BN(10).pow(new BN(api.registry.chainDecimals[0]));
    const signers = await getSigners();
    const Alice = signers[0];
    const { address: sender } = await getRandomSigner(Alice, one.muln(1000));

    const contractFactory = await getContractFactory("erc20", sender);
    const contract = await contractFactory.deploy("new", "1000");
    const abi = artifacts.readArtifact("erc20");
    const { address: receiver } = await getRandomSigner();

    return { sender, contractFactory, contract, abi, receiver, Alice, one };
  }

  it("Assigns initial balance", async () => {
    const { contract, sender } = await setup();
    const result = await contract.query.balanceOf(sender);
    expect(result.output).to.eq(1000);
  });

  it("Transfer adds amount to destination account", async () => {
    const { contract, receiver } = await setup();
    await expect(() => contract.tx.transfer(receiver, 7)).to.changeTokenBalance(
      contract,
      receiver,
      7
    );

    await expect(() =>
      contract.tx.transfer(receiver, 7)
    ).to.changeTokenBalances(contract, [contract.signer, receiver], [-7, 7]);
  });

  it("Transfer emits event", async () => {
    const { contract, sender, receiver } = await setup();

    await expect(contract.tx.transfer(receiver, 7))
      .to.emit(contract, "Transfer")
      .withArgs(sender, receiver, 7);
  });

  it("Can not transfer above the amount", async () => {
    const { contract, receiver } = await setup();

    await expect(contract.tx.transfer(receiver, 1007)).to.not.emit(
      contract,
      "Transfer"
    );
  });

  it("Can not transfer from empty account", async () => {
    const { contract, Alice, one, sender } = await setup();

    const emptyAccount = await getRandomSigner(Alice, one.muln(10000));

    await expect(
      contract.connect(emptyAccount).tx.transfer(sender, 7)
    ).to.not.emit(contract, "Transfer");
  });
});
