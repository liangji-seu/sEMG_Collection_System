import unittest
import os
import tempfile
from unittest.mock import patch

import h5py
import zmq
from threading import Lock

from storage_server import EMG_250HZ_ADC_DTYPE, HDF5StorageServer


class FakeDataSocket:
    def __init__(self, messages):
        self.messages = list(messages)

    def recv_json(self, flags=0):
        if self.messages:
            return self.messages.pop(0)
        raise zmq.Again()


class StorageBarrierTests(unittest.TestCase):
    def test_drain_waits_for_target_sequence_on_data_channel(self):
        server = HDF5StorageServer.__new__(HDF5StorageServer)
        server.last_data_sequence = 0
        server.data_barrier_timeout_ms = 10
        server.data_write_error = None
        server.data_socket = FakeDataSocket([
            {"cmd": "append", "params": {"_storage_seq": 7}}
        ])
        appended = []
        server.append_data = lambda params: appended.append(params) or {
            "status": "success"
        }

        server._drain_data_until(7)

        self.assertEqual(server.last_data_sequence, 7)
        self.assertEqual(appended, [{"_storage_seq": 7}])

    def test_append_failure_does_not_ack_sequence(self):
        server = HDF5StorageServer.__new__(HDF5StorageServer)
        server.last_data_sequence = 0
        server.data_barrier_timeout_ms = 10
        server.data_write_error = None
        server.data_socket = FakeDataSocket([
            {"cmd": "append", "params": {"_storage_seq": 7}}
        ])
        server.append_data = lambda params: {"status": "error", "msg": "closed"}

        self.assertFalse(server._drain_data_until(7))
        self.assertEqual(server.last_data_sequence, 0)

    def test_previous_write_failure_blocks_later_successful_sequence(self):
        server = HDF5StorageServer.__new__(HDF5StorageServer)
        server.last_data_sequence = 0
        server.data_barrier_timeout_ms = 10
        server.data_write_error = None
        calls = []

        def append_data(params):
            calls.append(params)
            return {"status": "error" if params["_storage_seq"] == 1 else "success"}

        server.append_data = append_data
        self.assertFalse(server._process_data_request({"cmd": "append", "params": {"_storage_seq": 1}}))
        self.assertIn("append failed", server.data_write_error)
        self.assertFalse(server._process_data_request({"cmd": "append", "params": {"_storage_seq": 2}}))
        self.assertEqual(calls, [{"_storage_seq": 1}, {"_storage_seq": 2}])
        self.assertFalse(server._drain_data_until(2))

    def test_underlying_h5_write_exception_returns_append_error(self):
        fd, path = tempfile.mkstemp(suffix=".h5", dir=os.path.dirname(__file__))
        os.close(fd)
        try:
            with h5py.File(path, "w") as writable:
                writable.create_dataset("emg1_250hz_adc", shape=(0,), maxshape=(None,), dtype=EMG_250HZ_ADC_DTYPE)
            with h5py.File(path, "r") as readonly:
                server = HDF5StorageServer.__new__(HDF5StorageServer)
                server.f = readonly
                server.stats = {"emg1_frames": 0}
                server.data_write_error = None
                with self.assertRaises((OSError, RuntimeError)):
                    server._append_emg("emg1", [[1] for _ in range(16)], [1.0], [1])
                self.assertIn("write intent", server.data_write_error.lower())
        finally:
            os.unlink(path)

    def test_create_refuses_to_replace_open_file(self):
        server = HDF5StorageServer.__new__(HDF5StorageServer)
        server.f = object()
        result = server.create_file({})
        self.assertEqual(result["status"], "error")
        self.assertIn("拒绝覆盖", result["msg"])


class StorageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="storage-test-", dir=os.path.dirname(__file__))
        with patch("storage_server.zmq.Context"):
            self.server = HDF5StorageServer(storage_dir=self.temp.name)
        self.server.data_socket = FakeDataSocket([])

    def tearDown(self):
        if self.server.f is not None:
            self.server.f.close()
        self.assertEqual(os.path.dirname(os.path.abspath(self.temp.name)), os.path.dirname(os.path.abspath(__file__)))
        self.temp.cleanup()

    def create(self, token):
        return self.server.handle_control("create", {"_storage_file_token": token, "user_id": "test"})

    def test_same_create_is_idempotent_different_identity_and_legacy_cannot_replace(self):
        first = self.create("a")
        self.assertEqual(first["status"], "success")
        repeated = self.create("a")
        self.assertTrue(repeated["idempotent"])
        self.assertEqual(repeated["file_path"], first["file_path"])
        self.assertEqual(self.create("b")["status"], "error")
        self.assertEqual(self.create(None)["status"], "error")
        self.assertEqual(self.server.handle_control("append", {"data": {}})["status"], "error")
        self.assertEqual(self.server.handle_control("close", {})["status"], "error")
        self.assertEqual(self.server.get_file_status()["file_token"], "a")

    def test_old_data_and_old_close_do_not_touch_next_file(self):
        self.create("a")
        close_a = {"_storage_file_token": "a", "_storage_data_seq": 0}
        self.assertEqual(self.server.handle_control("close", close_a)["status"], "success")
        self.create("b")
        new_path = self.server.file_path
        stale = {"cmd": "append", "params": {"_storage_file_token": "a", "_storage_seq": 1,
            "data": {"prompt_name": "OLD", "prompt_time": 1}}}
        self.assertFalse(self.server._process_data_request(stale))
        self.assertEqual(len(self.server.f["prompts"]["names"]), 0)
        self.assertTrue(self.server.handle_control("close", close_a)["idempotent"])
        self.assertIsNotNone(self.server.f)
        self.assertEqual(self.server.file_path, new_path)
        self.assertEqual(self.create("a")["status"], "error")
        self.assertIsNone(self.server.data_write_error)

    def test_real_readonly_h5_failure_drains_received_and_finalizes_incomplete(self):
        self.create("a")
        path = self.server.file_path
        self.server.f.close()
        self.server.f = h5py.File(path, "r")
        data = {"emg1": [[1] for _ in range(16)], "emg1_t": [1.0], "emg1_frame_ids": [1]}
        self.server.data_socket = FakeDataSocket([
            {"cmd": "append", "params": {"_storage_file_token": "a", "_storage_seq": 1, "data": data}},
            {"cmd": "append", "params": {"_storage_file_token": "a", "_storage_seq": 2, "data": {}}},
        ])
        params = {"_storage_file_token": "a", "_storage_data_seq": 2}
        self.assertEqual(self.server.handle_control("close", params)["status"], "error")
        self.assertEqual(self.server.last_received_sequence, 1)
        self.assertEqual(self.server.last_data_sequence, 0)
        self.assertIn("write intent", self.server.data_write_error)
        # Restore write access after the fault, exactly as a repaired storage
        # destination would; sticky integrity failure must still block completed.
        self.server.f.close()
        self.server.f = h5py.File(path, "r+")
        self.assertEqual(self.server.handle_control("close", params)["status"], "error")
        result = self.server.handle_control("finalize_incomplete", params)
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.server.last_received_sequence, 2)
        with h5py.File(path, "r") as saved:
            self.assertEqual(saved.attrs["collection_status"], "incomplete")
            self.assertIn("write intent", saved.attrs["storage_error"])
            self.assertEqual(saved.attrs["storage_received_sequence"], 2)
            self.assertEqual(saved.attrs["storage_written_sequence"], 0)
        self.assertEqual(self.create("b")["status"], "success")
        self.assertIsNone(self.server.data_write_error)

    def test_repeated_sequence_does_not_duplicate_prompt(self):
        self.create("a")
        request = {"cmd": "append", "params": {"_storage_file_token": "a", "_storage_seq": 1,
            "data": {"prompt_name": "one", "prompt_time": 1}}}
        self.assertTrue(self.server._process_data_request(request))
        self.assertTrue(self.server._process_data_request(request))
        self.assertEqual(len(self.server.f["prompts"]["names"]), 1)

    def test_sequence_gap_cannot_be_finalized_as_complete(self):
        self.create("a")
        for sequence in (1, 3):
            self.server._process_data_request({"cmd": "append", "params": {
                "_storage_file_token": "a", "_storage_seq": sequence,
                "data": {"prompt_name": str(sequence), "prompt_time": sequence}}})
        self.assertIn("expected 2, received 3", self.server.data_write_error)
        params = {"_storage_file_token": "a", "_storage_data_seq": 3}
        self.assertEqual(self.server.handle_control("close", params)["status"], "error")
        self.assertEqual(self.server.handle_control("finalize_incomplete", params)["status"], "success")

    def test_rep_fallback_drains_earlier_push_before_appending(self):
        self.create("a")
        self.server.data_socket = FakeDataSocket([{"cmd": "append", "params": {
            "_storage_file_token": "a", "_storage_seq": 1,
            "data": {"prompt_name": "first", "prompt_time": 1}}}])
        result = self.server.handle_control("append", {"_storage_file_token": "a",
            "_storage_seq": 2, "data": {"prompt_name": "second", "prompt_time": 2}})
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.server.f['prompts/names'].asstr()[:].tolist(), ['first', 'second'])
        self.assertEqual(self.server.last_data_sequence, 2)

    def test_malformed_batch_rejected_before_either_device_is_written(self):
        self.create("a")
        good = [[1, 2] for _ in range(16)]
        data = {"emg1": good, "emg1_t": [1.0, 1.004], "emg1_frame_ids": [0, 1],
                "emg2": good, "emg2_t": [1.0], "emg2_frame_ids": [0, 1]}
        result = self.server.append_data({"_storage_file_token": "a", "data": data})
        self.assertEqual(result["status"], "error")
        self.assertEqual(len(self.server.f['emg1_250hz_adc']), 0)
        self.assertEqual(len(self.server.f['emg2_250hz_adc']), 0)

    def test_empty_device_batch_and_vectorized_sample_mapping(self):
        self.create("a")
        data = {"emg1": [[c*100+i for i in range(2)] for c in range(16)],
                "emg1_t": [1.0, 1.004], "emg1_frame_ids": [8, 9],
                "emg2": [[] for _ in range(16)], "emg2_t": [], "emg2_frame_ids": []}
        self.assertEqual(self.server.append_data({"_storage_file_token": "a", "data": data})["status"], "success")
        rows = self.server.f['emg1_250hz_adc'][:]
        self.assertEqual(rows['channels'].tolist(), [[c*100+i for c in range(16)] for i in range(2)])
        self.assertEqual(rows['sd_frame_id'].tolist(), [64, 72])
        self.assertEqual(len(self.server.f['emg2_250hz_adc']), 0)

    def test_legacy_session_remains_supported_but_rejects_tagged_data(self):
        self.assertEqual(self.create(None)["status"], "success")
        self.assertEqual(self.server.handle_control("append", {"data": {}})["status"], "success")
        self.assertEqual(self.server.handle_control("append", {"_storage_file_token": "x", "data": {}})["status"], "error")
        self.assertEqual(self.server.handle_control("close", {})["status"], "success")


if __name__ == "__main__":
    unittest.main()
