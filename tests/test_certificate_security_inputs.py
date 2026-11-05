#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Independent public-certificate identities must match the packaged revocations."""

import base64
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generator", ROOT / "scripts/generate-certificate-security.py")
GEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GEN)


class CertificateInputsTests(unittest.TestCase):
    def test_original_and_cross_signed_intermediates_are_revoked(self):
        manifest = json.loads((ROOT / "config/certificate-security-data.json").read_text())
        snapshot = json.loads((ROOT / "gecko" / manifest["onecrl"]["path"]).read_text())
        issuer_serial, subject_key = map(set, GEN.revocation_keys(snapshot))
        identities = json.loads((ROOT / "tests/certificate-security-identities.json").read_text())["certificates"]
        self.assertEqual(len(identities), 12)
        self.assertEqual(len({c["certificate_sha256"] for c in identities}), 12)
        self.assertEqual(len({c["spki_sha256"] for c in identities}), 6)
        for cert in identities:
            with self.subTest(certificate=cert["name"]):
                # Subject/SPKI records are essential: issuer/serial alone did
                # not cover the cross-signed paths in the earlier ESR dump.
                subject = base64.b64decode(cert["subject"])
                digest = base64.b64decode(cert["spki_sha256"])
                self.assertIn(subject + digest, subject_key)
                self.assertNotIn(subject + bytes(32), subject_key)
                if "-aaa" not in cert["name"]:
                    self.assertIn(base64.b64decode(cert["issuer"]) + base64.b64decode(cert["serial"]), issuer_serial)

    def test_malformed_or_deleted_revocations_fail_generation(self):
        for record in ({"id": "unknown"}, {"deleted": True},
                       {"subject": "YQ==", "pubKeyHash": "Yg=="},
                       {"issuerName": "?", "serialNumber": "Yg=="}):
            with self.subTest(record=record), self.assertRaises(ValueError):
                GEN.revocation_keys({"data": [record]})


if __name__ == "__main__":
    unittest.main()
