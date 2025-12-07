const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BSC_LiquidationV3", function () {
    let liquidation;
    let owner;
    let borrower;

    const PANCAKE_V3_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
    const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
    const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";

    before(async function () {
        [owner, borrower] = await ethers.getSigners();
        
        const BSC_LiquidationV3 = await ethers.getContractFactory("BSC_LiquidationV3");
        liquidation = await BSC_LiquidationV3.deploy(
            PANCAKE_V3_ROUTER,
            PANCAKE_V3_FACTORY,
            VENUS_COMPTROLLER
        );
        await liquidation.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            expect(await liquidation.owner()).to.equal(owner.address);
        });

        it("Should set correct addresses", async function () {
            expect(await liquidation.pancakeV3Router()).to.equal(PANCAKE_V3_ROUTER);
            expect(await liquidation.pancakeV3Factory()).to.equal(PANCAKE_V3_FACTORY);
            expect(await liquidation.venusComptroller()).to.equal(VENUS_COMPTROLLER);
        });
    });

    describe("Access Control", function () {
        it("Should only allow owner to execute liquidation", async function () {
            // This will fail because no actual underwater position exists
            // But tests that non-owner cannot call
            await expect(
                liquidation.connect(borrower).executeLiquidation(
                    borrower.address,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    0,
                    3000
                )
            ).to.be.revertedWith("Only owner");
        });
    });
});
