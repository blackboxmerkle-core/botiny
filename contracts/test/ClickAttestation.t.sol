// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ClickAttestation} from "../src/ClickAttestation.sol";
import {Vm, Log} from "./Vm.sol";

contract ClickAttestationTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ClickAttestation c;
    address constant ATT = address(0xA77E57);
    address constant EVE = address(0xE5E);

    function setUp() public { c = new ClickAttestation(ATT); }

    function _item(uint256 i, uint8 st) internal pure returns (ClickAttestation.ClickIn memory) {
        return ClickAttestation.ClickIn(keccak256(abi.encode("l", i)), keccak256(abi.encode("c", i)), keccak256(abi.encode("camp", i % 2)), st, uint16(i), uint64(1_760_000_000 + i));
    }
    function _batch(uint256 n, uint256 off) internal pure returns (ClickAttestation.ClickIn[] memory b) {
        b = new ClickAttestation.ClickIn[](n);
        for (uint256 i; i < n; ++i) b[i] = _item(i + off, 1);
    }

    function test_onlyAttesterCanWrite() public {
        vm.prank(EVE); vm.expectRevert(ClickAttestation.NotAttester.selector); c.attestBatch(_batch(1, 0));
        ClickAttestation.StatusIn[] memory s = new ClickAttestation.StatusIn[](0);
        vm.prank(EVE); vm.expectRevert(ClickAttestation.NotAttester.selector); c.updateStatusBatch(s);
        vm.prank(EVE); vm.expectRevert(ClickAttestation.NotOwner.selector); c.setAttester(EVE, true);
    }

    function test_batchEmitsOneEventPerClickWithFields() public {
        vm.recordLogs();
        vm.prank(ATT); uint256 w = c.attestBatch(_batch(50, 0));
        require(w == 50 && c.clickCount() == 50, "count");
        Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 50, "logs");
        ClickAttestation.ClickIn memory x = _item(7, 1);
        require(logs[7].topics[0] == ClickAttestation.Click.selector, "topic0");
        require(logs[7].topics[1] == x.linkHash && logs[7].topics[2] == x.clickHash && logs[7].topics[3] == x.campaignHash, "topics");
        (uint8 st, uint16 rs, uint64 at) = abi.decode(logs[7].data, (uint8, uint16, uint64));
        require(st == 1 && rs == 7 && at == x.at, "data");
        require(logs[7].emitter == address(c), "emitter");
    }

    function test_idempotentRetry() public {
        vm.prank(ATT); c.attestBatch(_batch(10, 0));
        vm.recordLogs();
        vm.prank(ATT); uint256 w = c.attestBatch(_batch(15, 5));   // 5 dupes + 10 new
        require(w == 10 && c.clickCount() == 20, "dedupe");
        require(vm.getRecordedLogs().length == 10, "no dup events");
    }

    function test_statusUpdates() public {
        vm.prank(ATT); c.attestBatch(_batch(3, 0));
        ClickAttestation.StatusIn[] memory s = new ClickAttestation.StatusIn[](3);
        s[0] = ClickAttestation.StatusIn(keccak256(abi.encode("c", uint256(0))), keccak256(abi.encode("camp", uint256(0))), 5, 0, 1_760_100_000); // vested
        s[1] = ClickAttestation.StatusIn(keccak256(abi.encode("c", uint256(1))), keccak256(abi.encode("camp", uint256(1))), 4, 14, 1_760_100_001); // clawed
        s[2] = ClickAttestation.StatusIn(keccak256(abi.encode("c", uint256(2))), keccak256(abi.encode("camp", uint256(0))), 1, 0, 1_760_100_002); // unchanged -> skipped
        vm.recordLogs();
        vm.prank(ATT); uint256 w = c.updateStatusBatch(s);
        require(w == 2, "written");
        Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2 && logs[0].topics[0] == ClickAttestation.StatusUpdate.selector, "evt");
        require(logs[1].topics[2] == keccak256(abi.encode("camp", uint256(1))), "campaign carried");
        require(c.statusOf(s[0].clickHash) == 5 && c.statusOf(s[1].clickHash) == 4, "state");
    }

    function test_rejectsBadInput() public {
        ClickAttestation.ClickIn[] memory b = _batch(1, 0); b[0].status = 9;
        vm.prank(ATT); vm.expectRevert(abi.encodeWithSelector(ClickAttestation.BadStatus.selector, uint8(9))); c.attestBatch(b);
        b[0].status = 1; b[0].clickHash = bytes32(0);
        vm.prank(ATT); vm.expectRevert(ClickAttestation.ZeroHash.selector); c.attestBatch(b);
        ClickAttestation.StatusIn[] memory s = new ClickAttestation.StatusIn[](1);
        s[0] = ClickAttestation.StatusIn(keccak256("nope"), keccak256("x"), 5, 0, 1);
        vm.prank(ATT); vm.expectRevert(abi.encodeWithSelector(ClickAttestation.UnknownClick.selector, keccak256("nope"))); c.updateStatusBatch(s);
    }

    function test_campaignMustMatchOnUpdate() public {
        vm.prank(ATT); c.attestBatch(_batch(1, 0));
        ClickAttestation.StatusIn[] memory s = new ClickAttestation.StatusIn[](1);
        s[0] = ClickAttestation.StatusIn(keccak256(abi.encode("c", uint256(0))), keccak256("other campaign"), 5, 0, 1);
        vm.prank(ATT); vm.expectRevert(abi.encodeWithSelector(ClickAttestation.CampaignMismatch.selector, s[0].clickHash)); c.updateStatusBatch(s);
    }

    function test_ownerManagesAttesters() public {
        c.setAttester(EVE, true);
        vm.prank(EVE); c.attestBatch(_batch(1, 0));
        c.setAttester(EVE, false);
        vm.prank(EVE); vm.expectRevert(ClickAttestation.NotAttester.selector); c.attestBatch(_batch(1, 1));
        c.transferOwnership(EVE);
        vm.expectRevert(ClickAttestation.NotOwner.selector); c.setAttester(ATT, false);
    }

    function test_gas_batch100() public {
        vm.prank(ATT); c.attestBatch(_batch(100, 1000));   // see `forge test --gas-report`
    }
}
