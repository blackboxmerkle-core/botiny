// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Minimal cheatcode interface (no forge-std dependency, so `forge test` works offline).
struct Log { bytes32[] topics; bytes data; address emitter; }
interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}
