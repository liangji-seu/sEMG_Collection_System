"""Exercise actual Node ZeroMQ -> Python storage -> HDF5 close barriers."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

NODE_CLIENT = r'''
const zmq = require('zeromq');
const port = Number(process.argv[1]);
const req = new zmq.Request({receiveTimeout: 10000, sendTimeout: 5000, linger: 0});
const push = new zmq.Push({sendTimeout: 5000, linger: 0});
req.connect(`tcp://127.0.0.1:${port}`);
push.connect(`tcp://127.0.0.1:${port+1}`);
async function rpc(cmd, params = {}) {
  await req.send(JSON.stringify({cmd, params}));
  const [reply] = await req.receive();
  return JSON.parse(reply.toString());
}
(async () => {
  const token = 'integration-file-a';
  const first = await rpc('create', {_storage_file_token: token, user_id: 'test', stage_name: 'wire'});
  if(first.status !== 'success') throw new Error(JSON.stringify(first));
  for(let i=1;i<=200;i++) {
    await push.send(JSON.stringify({cmd:'append',params:{_storage_file_token:token,_storage_seq:i,
      data:{emg1:Array.from({length:16},(_,c)=>[c*1000+i]),emg1_t:[1000+i/250],emg1_frame_ids:[i]}}}));
  }
  const close = await rpc('close', {_storage_file_token:token,_storage_data_seq:200});
  if(close.status !== 'success') throw new Error(JSON.stringify(close));
  const second = await rpc('create', {_storage_file_token:'integration-file-b',user_id:'test',stage_name:'wire'});
  // An old PUSH after a new file opens must be ignored, including its sequence.
  await push.send(JSON.stringify({cmd:'append',params:{_storage_file_token:token,_storage_seq:201,
    data:{prompt_name:'stale',prompt_time:2}}}));
  const fallback = await rpc('append', {_storage_file_token:'integration-file-b',_storage_seq:1,
    data:{prompt_name:'fresh',prompt_time:3}});
  const close2 = await rpc('close', {_storage_file_token:'integration-file-b',_storage_data_seq:1});
  console.log(JSON.stringify({first,close,second,fallback,close2}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{req.close();push.close();});
'''


class StorageWireTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node runtime unavailable')
    def test_node_push_rep_barrier_and_stale_identity(self):
        # Reserve/check consecutive ports without relying on project defaults.
        for _ in range(30):
            with socket.socket() as first, socket.socket() as second:
                first.bind(('127.0.0.1', 0))
                port = first.getsockname()[1]
                if port == 65535:
                    continue
                try:
                    second.bind(('127.0.0.1', port+1))
                    break
                except OSError:
                    continue
        else:
            self.fail('No free consecutive loopback ports')
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests', prefix='wire-') as directory:
            with open(Path(directory) / 'service.log', 'wb') as log:
                service = subprocess.Popen([sys.executable, '-u', str(ROOT / 'storage_server.py'),
                    '--port', str(port), '--storage_dir', directory], stdout=log, stderr=log, cwd=ROOT)
                try:
                    deadline = time.monotonic() + 10
                    while True:
                        if service.poll() is not None:
                            self.fail('Storage exited before readiness')
                        try:
                            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                                break
                        except OSError:
                            if time.monotonic() >= deadline:
                                self.fail('Storage readiness timeout')
                            time.sleep(.02)
                    result = subprocess.run(['node', '-e', NODE_CLIENT, str(port)],
                                            capture_output=True, timeout=30, cwd=ROOT)
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                    response = json.loads(result.stdout)
                    self.assertEqual(response['fallback']['status'], 'success')
                    with h5py.File(response['first']['file_path'], 'r') as file:
                        rows = file['emg1_250hz_adc'][:]
                        self.assertEqual(len(rows), 200)
                        np.testing.assert_array_equal(rows['frame_id'], np.arange(1,201))
                        np.testing.assert_array_equal(rows['channels'][:,5], np.arange(1,201)+5000)
                        self.assertEqual(file.attrs['storage_written_sequence'], 200)
                    with h5py.File(response['second']['file_path'], 'r') as file:
                        self.assertEqual(file['prompts/names'].asstr()[:].tolist(), ['fresh'])
                        self.assertEqual(file.attrs['storage_written_sequence'], 1)
                finally:
                    service.terminate()
                    try:
                        service.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        service.kill()
                        service.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
