// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Botiny ClickAttestation (SKALE Europa TESTNET)
/// @notice Public per-click attestation feed. One `Click` event per click (first status) and a
///         `StatusUpdate` event for every later status change. No personal data: every field is a hash.
///         - linkHash     = keccak256("botiny.link.v1|" + short_code)
///         - clickHash    = keccak256("botiny.click.v1|" + daily-salted visitor key + "|" + click_id)  (never a raw IP)
///         - campaignHash = keccak256("botiny.campaign.v1|" + advertiser salt + "|" + advertiser_id + "|" + listing_id)
///         Only authorised attesters can write. Writes are idempotent: re-attesting a known clickHash, or
///         setting the status it already has, is a silent no-op (safe retries).
contract ClickAttestation {
    // status codes
    uint8 public constant PAID = 1;
    uint8 public constant FILTERED = 2;
    uint8 public constant HELD = 3;
    uint8 public constant CLAWED = 4;
    uint8 public constant VESTED = 5;
    uint8 public constant MAX_STATUS = 5;

    struct ClickIn {
        bytes32 linkHash;
        bytes32 clickHash;
        bytes32 campaignHash;
        uint8 status;
        uint16 reason;
        uint64 at;          // click time, unix seconds
    }
    struct StatusIn {
        bytes32 clickHash;
        bytes32 campaignHash; // must match the attested click's campaign
        uint8 status;
        uint16 reason;
        uint64 at;          // time of the status change, unix seconds
    }

    event Click(bytes32 indexed linkHash, bytes32 indexed clickHash, bytes32 indexed campaignHash, uint8 status, uint16 reason, uint64 at);
    event StatusUpdate(bytes32 indexed clickHash, bytes32 indexed campaignHash, uint8 status, uint16 reason, uint64 at);
    event AttesterSet(address indexed attester, bool allowed);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotAttester();
    error BadStatus(uint8 status);
    error UnknownClick(bytes32 clickHash);
    error ZeroHash();
    error CampaignMismatch(bytes32 clickHash);

    address public owner;
    mapping(address => bool) public isAttester;
    /// @dev One storage slot per click: high 248 bits of campaignHash | status (low byte). Keeps writes cheap.
    mapping(bytes32 => uint256) internal rec;
    uint256 private constant LOW = 0xff;
    uint256 public clickCount;

    constructor(address attester) {
        owner = msg.sender;
        emit OwnerChanged(msg.sender);
        if (attester != address(0)) { isAttester[attester] = true; emit AttesterSet(attester, true); }
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyAttester() { if (!isAttester[msg.sender]) revert NotAttester(); _; }

    function setAttester(address a, bool allowed) external onlyOwner { isAttester[a] = allowed; emit AttesterSet(a, allowed); }
    function transferOwnership(address o) external onlyOwner { owner = o; emit OwnerChanged(o); }

    /// @notice Attest many clicks in one tx. Already-known clickHashes are skipped (idempotent).
    /// @return written number of new Click events emitted
    function attestBatch(ClickIn[] calldata items) external onlyAttester returns (uint256 written) {
        for (uint256 i; i < items.length; ++i) {
            ClickIn calldata c = items[i];
            if (c.status == 0 || c.status > MAX_STATUS) revert BadStatus(c.status);
            if (c.clickHash == bytes32(0) || c.campaignHash == bytes32(0) || c.linkHash == bytes32(0)) revert ZeroHash();
            if (rec[c.clickHash] != 0) continue;
            rec[c.clickHash] = (uint256(c.campaignHash) & ~LOW) | c.status;
            emit Click(c.linkHash, c.clickHash, c.campaignHash, c.status, c.reason, c.at);
            ++written;
        }
        clickCount += written;
    }

    /// @notice Batch status changes (hold / vest / clawback ...). Unchanged statuses are skipped.
    function updateStatusBatch(StatusIn[] calldata items) external onlyAttester returns (uint256 written) {
        for (uint256 i; i < items.length; ++i) {
            StatusIn calldata s = items[i];
            if (s.status == 0 || s.status > MAX_STATUS) revert BadStatus(s.status);
            uint256 r = rec[s.clickHash];
            if (r == 0) revert UnknownClick(s.clickHash);
            if ((r & ~LOW) != (uint256(s.campaignHash) & ~LOW)) revert CampaignMismatch(s.clickHash);
            if (uint8(r) == s.status) continue;
            rec[s.clickHash] = (r & ~LOW) | s.status;
            emit StatusUpdate(s.clickHash, s.campaignHash, s.status, s.reason, s.at);
            ++written;
        }
    }

    function statusOf(bytes32 clickHash) external view returns (uint8) { return uint8(rec[clickHash]); }
}
