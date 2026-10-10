import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("decrypt_log", ROOT / "tools/decrypt-log.py")
decrypt_log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decrypt_log)


class DecryptLogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.fixture.name)
        # Generate a real finalized log with the Electron client's existing journal implementation.
        subprocess.run(["node", "-e", """
const fs = require('node:fs'), path = require('node:path');
const { logs, auth, trust, store, decryptLog } = require('./tests/helpers');
const AuditLogger = require('./app/main/audit-logger');
const dir = process.argv[1];
(async () => {
  const journal = new AuditLogger({ directory: path.join(dir, 'journal'), protectedStore: store(path.join(dir, 'secrets')),
    logPublicKey: trust.logPublicKey, keyId: trust.keyId, binding: { uid: 7, domainId: 'exam', tid: 'a'.repeat(24), attemptId: 'b'.repeat(24) } });
  journal.append('TEST_EVENT', { detail: '日志中文测试' });
  const file = await journal.finalize();
  fs.copyFileSync(file, path.join(dir, 'sample.hplog'));
  fs.writeFileSync(path.join(dir, 'log-private.pem'), logs.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'auth-private.pem'), auth.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(decryptLog(file)));
})().catch(error => { console.error(error); process.exitCode = 1; });
""", str(cls.folder)], cwd=ROOT, check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "output.log"
        self.source = self.folder / "sample.hplog"
        self.key = self.folder / "log-private.pem"

    def tearDown(self):
        self.temp.cleanup()

    def test_real_node_log_decrypts_without_changing_records(self):
        result = decrypt_log.decrypt(self.source, self.key, self.output)
        self.assertEqual(result, self.output)
        actual = [json.loads(line) for line in self.output.read_text().splitlines()]
        self.assertEqual(actual, json.loads((self.folder / "expected.json").read_text()))
        self.assertIn("日志中文测试", self.output.read_text())

    def test_export_json_and_expected_id(self):
        export = Path(self.temp.name) / "keys.json"
        export.write_text(json.dumps({"privateKeys": {"keyId": "a" * 32, "encryptionPrivateKey": self.key.read_text()}}))
        decrypt_log.decrypt(self.source, export, self.output)
        self.assertTrue(self.output.exists())
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, export, self.output, expected_key_id="b" * 32, force=True)

    def test_tampered_truncated_or_wrong_key_leaves_no_plaintext(self):
        for content in [self.source.read_bytes()[:-1], self.source.read_bytes()[:-1] + b"X", b"not a log", b"HYDRO-PROCTOR-LOG/1\n[]\n"]:
            bad = Path(self.temp.name) / "bad.hplog"
            bad.write_bytes(content)
            with self.assertRaises((ValueError, decrypt_log.InvalidTag)):
                decrypt_log.decrypt(bad, self.key, self.output)
            self.assertFalse(self.output.exists())
            self.assertEqual(list(Path(self.temp.name).glob(".hydro-log-*")), [])
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, self.folder / "auth-private.pem", self.output)
        wrong = Path(self.temp.name) / "wrong-private.pem"
        wrong.write_bytes(rsa.generate_private_key(public_exponent=65537, key_size=3072).private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, wrong, self.output)
        self.assertFalse(self.output.exists())

    def test_existing_output_survives_failure_and_requires_explicit_overwrite(self):
        self.output.write_text("keep existing")
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, self.key, self.output)
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, self.key, self.output, expected_key_id="b" * 32, force=True)
        self.assertEqual(self.output.read_text(), "keep existing")
        decrypt_log.decrypt(self.source, self.key, self.output, force=True)
        self.assertNotEqual(self.output.read_text(), "keep existing")
        with self.assertRaises(ValueError):
            decrypt_log.decrypt(self.source, self.key, self.key, force=True)

    def test_cli_does_not_disclose_private_key_on_error(self):
        result = subprocess.run(["python3", str(ROOT / "tools/decrypt-log.py"), str(self.source), "--private-key",
                                 str(self.folder / "auth-private.pem"), "-o", str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("PRIVATE KEY", result.stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
