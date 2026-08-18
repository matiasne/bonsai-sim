// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "openzeppelin-contracts/token/common/ERC2981.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";
import {Base64} from "openzeppelin-contracts/utils/Base64.sol";
import {Strings} from "openzeppelin-contracts/utils/Strings.sol";

/// @title Pixel Bonsai — living NFTs
/// @notice Each token holds a bonsai's DNA: the compressed, canonical envelope
///         (seed + full care history) that the game at mydigitalbonsai.com
///         replays deterministically into the exact tree. The token is ALIVE:
///         its owner may push updated envelopes as the tree grows — or dies.
/// @dev    The chain stores the envelope; it does not verify it. Since v3
///         envelopes the open sim replays bit-identically on every JS engine
///         (pinned math), so anyone can check a tree off-chain; trustless
///         on-chain verification would require porting that sim — future work.
///         `treeId`/`simT` are client-supplied honesty rails, not proofs.
///
///         Buyer protection: a LIVING token is mutable by its owner, so a
///         seller could swap the DNA under a pending sale. `lockUpdates` lets
///         the owner freeze the DNA until a timestamp — the lock may only
///         extend (never shorten), and clears automatically when the token
///         changes hands, so the buyer can play immediately. Check
///         `updatesLockedUntil(tokenId)` covers your purchase window.
contract BonsaiTree is ERC721, ERC2981, Ownable {
    /// Envelope codes beyond this length would bloat tokenURI past what
    /// explorers/marketplaces render reliably.
    uint256 public constant MAX_DNA_LEN = 16384;

    uint256 public nextId = 1;
    string public viewerBase; // e.g. "https://mydigitalbonsai.com/#dna="
    string public imageURI;   // static fallback image for list views

    /// A lock further than a year out is almost certainly a mistake, and a
    /// year covers any realistic listing window.
    uint64 public constant MAX_LOCK_AHEAD = 366 days;

    mapping(uint256 tokenId => string) private _dna;      // latest envelope code
    mapping(uint256 tokenId => uint64) public simT;       // sim-seconds lived, monotonic
    mapping(bytes32 treeId => uint256) public tokenOfTree; // 0 = not minted
    mapping(uint256 tokenId => bytes32) public treeOf;
    mapping(uint256 tokenId => uint64) public updatesLockedUntil; // 0 = unlocked

    event Minted(uint256 indexed tokenId, bytes32 indexed treeId, address indexed owner);
    event Updated(uint256 indexed tokenId, uint64 simT);
    event UpdatesLocked(uint256 indexed tokenId, uint64 until); // until 0 = cleared by transfer

    error TreeAlreadyMinted(bytes32 treeId);
    error InvalidTreeId();
    error InvalidDna();
    error NotTokenOwner(uint256 tokenId);
    error TimeWentBackwards(uint64 have, uint64 got);
    error DnaLocked(uint256 tokenId, uint64 until);
    error LockMayOnlyExtend(uint64 have, uint64 got);
    error LockTooFarAhead(uint64 got, uint64 max);

    constructor(string memory viewerBase_, string memory imageURI_, address royaltyReceiver_, uint96 royaltyBps_)
        ERC721("Pixel Bonsai", "BONSAI")
        Ownable(msg.sender)
    {
        viewerBase = viewerBase_;
        imageURI = imageURI_;
        _setDefaultRoyalty(royaltyReceiver_, royaltyBps_); // ERC-2981, honored by marketplaces
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
        uint64 lockedUntil = updatesLockedUntil[tokenId];
        if (block.timestamp < lockedUntil) revert DnaLocked(tokenId, lockedUntil);
        uint64 have = simT[tokenId];
        if (simT_ < have) revert TimeWentBackwards(have, simT_);
        uint256 len = bytes(dnaCode).length;
        if (len == 0 || len > MAX_DNA_LEN) revert InvalidDna();

        _dna[tokenId] = dnaCode;
        simT[tokenId] = simT_;
        emit Updated(tokenId, simT_);
    }

    /// @notice Freeze the DNA until `until` (unix seconds) so a buyer knows the
    ///         tree they see is the tree they get. Monotonic: a live lock can
    ///         only be extended, never shortened or cleared by the seller —
    ///         only an actual transfer clears it (see _update).
    function lockUpdates(uint256 tokenId, uint64 until) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId);
        uint64 have = updatesLockedUntil[tokenId];
        if (until <= have) revert LockMayOnlyExtend(have, until);
        uint64 max = uint64(block.timestamp) + MAX_LOCK_AHEAD;
        if (until > max) revert LockTooFarAhead(until, max);
        updatesLockedUntil[tokenId] = until;
        emit UpdatesLocked(tokenId, until);
    }

    /// The lock protects a BUYER from the seller — once the token changes
    /// hands it has done its job, and the new owner plays immediately.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != from && updatesLockedUntil[tokenId] != 0) {
            delete updatesLockedUntil[tokenId];
            emit UpdatesLocked(tokenId, 0);
        }
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

    /// Secondary-sale royalty (ERC-2981). bps out of 10000, e.g. 500 = 5%.
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
