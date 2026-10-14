import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import type { HardhatUserConfig } from "hardhat/config";

import dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

// Sourcify only takes one browser URL, so pick the explorer of the network in use.
const usingMainnet = process.argv.includes("monadMainnet");
// `hardhat node` (npm run localnet) mines a block every LOCALNET_BLOCK_MS too,
// so challenge blocks and timestamps advance like on a live chain
const runningNode = process.argv.includes("node");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Monad allows 128 KB contracts (Ethereum: 24 KB)
      allowUnlimitedContractSize: true,
      mining: runningNode
        ? { auto: true, interval: Number(process.env.LOCALNET_BLOCK_MS ?? 1000) }
        : { auto: true },
    },
    monadTestnet: {
      url: process.env.TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
    monadMainnet: {
      url: process.env.MAINNET_RPC_URL || "https://rpc.monad.xyz",
      chainId: 143,
      accounts,
    },
  },
  // MonadVision (Sourcify) — no API key required
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify-api-monad.blockvision.org",
    browserUrl: usingMainnet ? "https://monadvision.com" : "https://testnet.monadvision.com",
  },
  // Monadscan (Etherscan V2 API) — only used when ETHERSCAN_API_KEY is set
  etherscan: {
    enabled: ETHERSCAN_API_KEY !== "",
    apiKey: { monadTestnet: ETHERSCAN_API_KEY, monadMainnet: ETHERSCAN_API_KEY },
    customChains: [
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=10143", browserURL: "https://testnet.monadscan.com" },
      },
      {
        network: "monadMainnet",
        chainId: 143,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=143", browserURL: "https://monadscan.com" },
      },
    ],
  },
  mocha: { timeout: 120_000 },
};

export default config;
