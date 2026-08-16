/* Pixel Bonsai — optional on-chain layer (Base Sepolia testnet).
   Lazily loaded ONLY when the user clicks MINT: normal play never touches this
   file, never loads ethers, never needs a wallet. The wallet is the only
   identity — there are no accounts anywhere in this game. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  const CFG = {
    // BonsaiTree.sol on Base Sepolia — see contracts/broadcast/ for the record.
    CONTRACT: '0x4e8445fb48f375b3315ccf07f2a14E35De6f7C02',
    CHAIN_ID: 84532,
    CHAIN_ID_HEX: '0x14a34',
    CHAIN_PARAMS: {
      chainId: '0x14a34',
      chainName: 'Base Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia.base.org'],
      blockExplorerUrls: ['https://sepolia.basescan.org'],
    },
    PUBLIC_RPC: 'https://sepolia.base.org',
    EXPLORER: 'https://sepolia.basescan.org',
    // ethers v6 UMD, CDN + fallback (same pattern as three.js in index.html)
    ETHERS_URLS: [
      'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.2/ethers.umd.min.js',
      'https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.umd.min.js',
    ],
    ABI: [
      'function mint(bytes32 treeId, string dnaCode, uint64 simT_) returns (uint256)',
      'function update(uint256 tokenId, string dnaCode, uint64 simT_)',
      'function tokenOfTree(bytes32 treeId) view returns (uint256)',
      'function dnaOf(uint256 tokenId) view returns (string)',
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function simT(uint256 tokenId) view returns (uint64)',
    ],
  };

  // keccak topic0 of ERC-721 Transfer(address,address,uint256)
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ZERO32 = '0x' + '0'.repeat(64);

  let ethersLoad = null;
  let signer = null;

  const Chain = {
    CFG,

    hasWallet() { return typeof root.ethereum !== 'undefined' && !!root.ethereum; },

    loadEthers() {
      if (root.ethers) return Promise.resolve(root.ethers);
      if (ethersLoad) return ethersLoad;
      ethersLoad = new Promise((resolve, reject) => {
        const tryUrl = (i) => {
          if (i >= CFG.ETHERS_URLS.length) return reject(new Error('could not load the wallet library'));
          const s = document.createElement('script');
          s.src = CFG.ETHERS_URLS[i];
          s.onload = () => root.ethers ? resolve(root.ethers) : tryUrl(i + 1);
          s.onerror = () => tryUrl(i + 1);
          document.head.appendChild(s);
        };
        tryUrl(0);
      });
      return ethersLoad;
    },

    async connect() {
      const provider = new root.ethers.BrowserProvider(root.ethereum);
      await provider.send('eth_requestAccounts', []);
      signer = await provider.getSigner();
      return signer;
    },

    async ensureNetwork() {
      try {
        await root.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CFG.CHAIN_ID_HEX }],
        });
      } catch (e) {
        if (e && (e.code === 4902 || /unrecognized|not added/i.test(e.message || ''))) {
          await root.ethereum.request({ method: 'wallet_addEthereumChain', params: [CFG.CHAIN_PARAMS] });
        } else throw e;
      }
      // the signer is chain-bound — rebuild it on the now-correct network
      return this.connect();
    },

    // A tree's immutable identity: its seed and genesis moment.
    treeIdOf(seed, g) { return root.ethers.id(seed + ':' + g); },

    _write() { return new root.ethers.Contract(CFG.CONTRACT, CFG.ABI, signer); },
    _read() {
      return new root.ethers.Contract(
        CFG.CONTRACT, CFG.ABI, new root.ethers.JsonRpcProvider(CFG.PUBLIC_RPC)
      );
    },

    async mint(opts) {
      const tx = await this._write().mint(opts.treeId, opts.dnaCode, opts.simT);
      const receipt = await tx.wait();
      const tokenId = Chain.parseTokenId(receipt.logs, CFG.CONTRACT);
      return { tokenId, txHash: receipt.hash };
    },

    async update(tokenId, dnaCode, simT) {
      const tx = await this._write().update(tokenId, dnaCode, simT);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    },

    // Read-only, no wallet needed (public RPC eth_call).
    async readTokenOfTree(treeId) {
      const id = await this._read().tokenOfTree(treeId);
      return Number(id);   // 0 = not minted
    },

    // PURE: pull the freshly-minted tokenId out of the receipt's ERC-721
    // Transfer(0x0 → minter) log. Node-testable with a fixture receipt.
    parseTokenId(logs, contract) {
      const want = String(contract).toLowerCase();
      for (const log of logs || []) {
        if (!log || String(log.address).toLowerCase() !== want) continue;
        const t = log.topics || [];
        if (t[0] !== TRANSFER_TOPIC || t[1] !== ZERO32 || t.length < 4) continue;
        return parseInt(t[3], 16);
      }
      return null;
    },
  };

  B.Chain = Chain;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
