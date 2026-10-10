#!/usr/bin/env python3
"""Decrypt a finalized Hydro proctor .hplog using the server's log private key."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"HYDRO-PROCTOR-LOG/1"


def decode(value, length):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid encrypted log header")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(data) != length or base64.urlsafe_b64encode(data).rstrip(b"=").decode() != value:
        raise ValueError("Invalid encrypted log header")
    return data


def load_key(filename, ask_password=False):
    content = Path(filename).read_bytes()
    key_id = None
    if content.lstrip().startswith(b"{"):
        exported = json.loads(content)
        exported = exported.get("privateKeys", exported.get("keys", exported))
        if not isinstance(exported, dict) or not isinstance(exported.get("encryptionPrivateKey"), str):
            raise ValueError("Invalid OJ private key export")
        key_id = exported["keyId"]
        content = exported["encryptionPrivateKey"].encode("utf-8")
    password = getpass.getpass("Private key password: ").encode() if ask_password else None
    key = serialization.load_pem_private_key(content, password=password)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
        raise ValueError("Use the RSA-3072 log decryption private key, not the authentication key")
    return key, key_id


def validate_plaintext(stream):
    stream.seek(0)
    seq = 0
    while True:
        line = stream.readline(4 * 1024 * 1024 + 1)
        if not line:
            break
        if len(line) > 4 * 1024 * 1024 or not line.endswith(b"\n"):
            raise ValueError("Invalid log record")
        record = json.loads(line.decode("utf-8"))
        if not isinstance(record, dict):
            raise ValueError("Invalid log record")
        if seq == 0:
            if record.get("protocol") != "hydro-journal/1" or not isinstance(record.get("binding"), dict):
                raise ValueError("Invalid log metadata")
        elif type(record.get("seq")) is not int or record["seq"] != seq or not isinstance(record.get("type"), str):
            raise ValueError("Invalid log sequence")
        seq += 1
    if seq < 2:
        raise ValueError("Log contains no audit events")


def decrypt(input_file, private_key, output_file=None, expected_key_id=None, force=False, ask_password=False):
    source = Path(input_file).resolve()
    target = Path(output_file).resolve() if output_file else source.with_suffix(".log")
    if target in (source, Path(private_key).resolve()):
        raise ValueError("Output must differ from the input and private key")
    if target.exists() and not force:
        raise ValueError("Output already exists; choose another path or use --force")
    key, exported_id = load_key(private_key, ask_password)
    if exported_id and expected_key_id and exported_id != expected_key_id:
        raise ValueError("Private key export does not match --key-id")
    expected_key_id = expected_key_id or exported_id
    temp_name = None
    try:
        with source.open("rb") as encrypted:
            if encrypted.readline(64) != MAGIC + b"\n":
                raise ValueError("Expected a finalized .hplog file")
            line = encrypted.readline(8193)
            if len(line) > 8192 or not line.endswith(b"\n"):
                raise ValueError("Invalid encrypted log header")
            header = json.loads(line)
            if not isinstance(header, dict):
                raise ValueError("Invalid encrypted log header")
            key_id = header.get("keyId")
            if not isinstance(key_id, str) or not re.fullmatch(r"[a-f0-9]{32}", key_id):
                raise ValueError("Invalid log key ID")
            if expected_key_id and expected_key_id != key_id:
                raise ValueError("Log key ID does not match the provided key")
            aes_key = key.decrypt(decode(header.get("wrappedKey"), 384), padding.OAEP(
                mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            if len(aes_key) != 32:
                raise ValueError("Invalid AES key")
            cipher = Cipher(algorithms.AES(aes_key), modes.GCM(decode(header.get("iv"), 12), decode(header.get("tag"), 16))).decryptor()
            cipher.authenticate_additional_data(MAGIC + b":" + key_id.encode("ascii"))
            # A private temporary file is removed on failure; output is published only after GCM authentication.
            with tempfile.NamedTemporaryFile(mode="w+b", dir=target.parent, prefix=".hydro-log-", delete=False) as output:
                temp_name = output.name
                while chunk := encrypted.read(1024 * 1024):
                    output.write(cipher.update(chunk))
                output.write(cipher.finalize())
                output.flush()
                validate_plaintext(output)
                os.fsync(output.fileno())
            if force:
                os.replace(temp_name, target)
            else:
                os.link(temp_name, target)  # Atomic creation: never overwrite an existing output.
        return target
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Finalized .hplog downloaded from the OJ")
    parser.add_argument("--private-key", required=True, help="Log RSA private key PEM or OJ key export JSON")
    parser.add_argument("-o", "--output", help="Output .log path (default: input basename with .log suffix)")
    parser.add_argument("--key-id", help="Optional expected 32-character log key ID")
    parser.add_argument("--password", action="store_true", help="Prompt for an encrypted PEM password")
    parser.add_argument("--force", action="store_true", help="Replace an existing output after successful authentication")
    args = parser.parse_args()
    try:
        target = decrypt(args.input, args.private_key, args.output, args.key_id, args.force, args.password)
    except InvalidTag:
        print("Decryption failed: log authentication failed (damaged or modified file).", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print("Decryption failed: check file format, log private key/key ID, password and output path.", file=sys.stderr)
        return 1
    print(f"Decrypted log: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
