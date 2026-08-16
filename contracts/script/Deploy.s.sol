// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BonsaiTree} from "../src/BonsaiTree.sol";

/// Deploy to Base Sepolia:
///   cd contracts && source .env
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        BonsaiTree nft = new BonsaiTree(
            "https://mydigitalbonsai.com/#dna=",
            "https://mydigitalbonsai.com/nft-placeholder.png"
        );
        vm.stopBroadcast();
        console.log("BonsaiTree deployed at:", address(nft));
    }
}
