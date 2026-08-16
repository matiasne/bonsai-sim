// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BonsaiTree} from "../src/BonsaiTree.sol";

/// Deploy to Base Sepolia:
///   cd contracts && source .env
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    function run() external {
        // accept the key with or without a 0x prefix (wallets export both ways)
        string memory pkStr = vm.envString("PRIVATE_KEY");
        bytes memory b = bytes(pkStr);
        if (b.length < 2 || b[0] != "0" || b[1] != "x") pkStr = string.concat("0x", pkStr);
        uint256 pk = vm.parseUint(pkStr);
        vm.startBroadcast(pk);
        BonsaiTree nft = new BonsaiTree(
            "https://mydigitalbonsai.com/#dna=",
            "https://mydigitalbonsai.com/nft-placeholder.png"
        );
        vm.stopBroadcast();
        console.log("BonsaiTree deployed at:", address(nft));
    }
}
