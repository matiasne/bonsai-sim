// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";

/// @title Pixel Bonsai — living NFTs
/// @notice Each token holds a bonsai's DNA: the compressed, canonical envelope
///         (seed + full care history) that the game at mydigitalbonsai.com
///         replays deterministically into the exact tree. The token is ALIVE:
///         its owner may push updated envelopes as the tree grows — or dies.
/// @dev    The chain stores the envelope; it does not verify it. Deterministic
///         replay is checkable by anyone off-chain (open sim), but trustless
///         on-chain verification would require a fixed-point sim — future work.
///         `treeId`/`simT` are client-supplied honesty rails, not proofs.
contract BonsaiTree is ERC721, Ownable {
    /// Envelope codes beyond this length would bloat tokenURI past what
    /// explorers/marketplaces render reliably.
    uint256 public constant MAX_DNA_LEN = 16384;

    uint256 public nextId = 1;
    string public viewerBase; // e.g. "https://mydigitalbonsai.com/#dna="
    string public imageURI;   // static fallback image for list views

    mapping(uint256 tokenId => string) private _dna;      // latest envelope code
    mapping(uint256 tokenId => uint64) public simT;       // sim-seconds lived, monotonic
    mapping(bytes32 treeId => uint256) public tokenOfTree; // 0 = not minted
    mapping(uint256 tokenId => bytes32) public treeOf;

    event Minted(uint256 indexed tokenId, bytes32 indexed treeId, address indexed owner);
    event Updated(uint256 indexed tokenId, uint64 simT);

    error TreeAlreadyMinted(bytes32 treeId);
    error InvalidTreeId();
    error InvalidDna();
    error NotTokenOwner(uint256 tokenId);
    error TimeWentBackwards(uint64 have, uint64 got);

    constructor(string memory viewerBase_, string memory imageURI_)
        ERC721("Pixel Bonsai", "BONSAI")
        Ownable(msg.sender)
    {
        viewerBase = viewerBase_;
        imageURI = imageURI_;
    }

    /// @param treeId keccak256 of the tree's immutable identity "seed:genesisMs"
    /// @param dnaCode the game's DNA code ("1"+base64url(deflate(canonical JSON)))
    /// @param simT_ the envelope's t (sim-seconds since genesis) at mint time
    function mint(bytes32 treeId, string calldata dnaCode, uint64 simT_) external returns (uint256 tokenId) {
        if (treeId == bytes32(0)) revert InvalidTreeId();
        if (tokenOfTree[treeId] != 0) revert TreeAlreadyMinted(treeId);
        uint256 len = bytes(dnaCode).length;
        if (len == 0 || len > MAX_DNA_LEN) revert InvalidDna();

        tokenId = nextId++;
        tokenOfTree[treeId] = tokenId;
        treeOf[tokenId] = treeId;
        _dna[tokenId] = dnaCode;
        simT[tokenId] = simT_;
        _safeMint(msg.sender, tokenId);
        emit Minted(tokenId, treeId, msg.sender);
    }

    /// @notice The living part: the token owner pushes the tree's latest
    ///         envelope. Sim-time may never rewind (equal is fine — actions
    ///         can land without time passing).
    function update(uint256 tokenId, string calldata dnaCode, uint64 simT_) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId);
        uint64 have = simT[tokenId];
        if (simT_ < have) revert TimeWentBackwards(have, simT_);
        uint256 len = bytes(dnaCode).length;
        if (len == 0 || len > MAX_DNA_LEN) revert InvalidDna();

        _dna[tokenId] = dnaCode;
        simT[tokenId] = simT_;
        emit Updated(tokenId, simT_);
    }

    function dnaOf(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _dna[tokenId];
    }

    /// @notice Fully on-chain metadata. animation_url opens the game's viewer,
    ///         which replays the stored envelope into the live 3D tree.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory id = Strings.toString(tokenId);
        string memory link = string.concat(viewerBase, _dna[tokenId]);
        string memory ageDays = Strings.toString(uint256(simT[tokenId]) / 86400);
        bytes memory json = abi.encodePacked(
            '{"name":"Pixel Bonsai #', id,
            '","description":"A living pixel bonsai. This token holds the tree\'s full DNA - its seed and entire care history - replayed deterministically by the game. It grows (and can die) as its owner tends it.",',
            '"external_url":"', link,
            '","animation_url":"', link,
            '","image":"', imageURI,
            '","attributes":[{"trait_type":"Age (days)","value":', ageDays,
            '},{"trait_type":"Tree ID","value":"', Strings.toHexString(uint256(treeOf[tokenId]), 32),
            '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    // The viewer/image endpoints may move hosts; tokens must survive that.
    function setViewerBase(string calldata viewerBase_) external onlyOwner {
        viewerBase = viewerBase_;
    }

    function setImageURI(string calldata imageURI_) external onlyOwner {
        imageURI = imageURI_;
    }
}
