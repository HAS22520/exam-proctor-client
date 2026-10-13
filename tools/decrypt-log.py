#!/usr/bin/env python3
"""使用服务端日志私钥，将最终 Hydro 监考 .hplog 解密为 .log 文件。"""
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
        raise ValueError("加密日志文件头无效")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(data) != length or base64.urlsafe_b64encode(data).rstrip(b"=").decode() != value:
        raise ValueError("加密日志文件头无效")
    return data


def load_key(filename, ask_password=False):
    content = Path(filename).read_bytes()
    key_id = None
    if content.lstrip().startswith(b"{"):
        exported = json.loads(content)
        exported = exported.get("privateKeys", exported.get("keys", exported))
        if not isinstance(exported, dict) or not isinstance(exported.get("encryptionPrivateKey"), str):
            raise ValueError("OJ 导出的私钥数据无效")
        key_id = exported["keyId"]
        content = exported["encryptionPrivateKey"].encode("utf-8")
    password = getpass.getpass("请输入私钥密码：").encode() if ask_password else None
    key = serialization.load_pem_private_key(content, password=password)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
        raise ValueError("请使用 RSA-3072 日志解密私钥，不要使用认证私钥")
    return key, key_id


def validate_plaintext(stream):
    stream.seek(0)
    seq = 0
    while True:
        line = stream.readline(4 * 1024 * 1024 + 1)
        if not line:
            break
        if len(line) > 4 * 1024 * 1024 or not line.endswith(b"\n"):
            raise ValueError("日志记录无效")
        record = json.loads(line.decode("utf-8"))
        if not isinstance(record, dict):
            raise ValueError("日志记录无效")
        if seq == 0:
            if record.get("protocol") != "hydro-journal/1" or not isinstance(record.get("binding"), dict):
                raise ValueError("日志元数据无效")
        elif type(record.get("seq")) is not int or record["seq"] != seq or not isinstance(record.get("type"), str):
            raise ValueError("日志序列无效")
        seq += 1
    if seq < 2:
        raise ValueError("日志不包含监考事件")


def decrypt(input_file, private_key, output_file=None, expected_key_id=None, force=False, ask_password=False):
    source = Path(input_file).resolve()
    target = Path(output_file).resolve() if output_file else source.with_suffix(".log")
    if target in (source, Path(private_key).resolve()):
        raise ValueError("输出路径不能与输入日志或私钥路径相同")
    if target.exists() and not force:
        raise ValueError("输出文件已存在，请更换路径或使用 --force")
    key, exported_id = load_key(private_key, ask_password)
    if exported_id and expected_key_id and exported_id != expected_key_id:
        raise ValueError("私钥导出的 keyId 与 --key-id 不一致")
    expected_key_id = expected_key_id or exported_id
    temp_name = None
    try:
        with source.open("rb") as encrypted:
            if encrypted.readline(64) != MAGIC + b"\n":
                raise ValueError("需要最终封存的 .hplog 文件")
            line = encrypted.readline(8193)
            if len(line) > 8192 or not line.endswith(b"\n"):
                raise ValueError("加密日志文件头无效")
            header = json.loads(line)
            if not isinstance(header, dict):
                raise ValueError("加密日志文件头无效")
            key_id = header.get("keyId")
            if not isinstance(key_id, str) or not re.fullmatch(r"[a-f0-9]{32}", key_id):
                raise ValueError("日志 keyId 无效")
            if expected_key_id and expected_key_id != key_id:
                raise ValueError("日志 keyId 与提供的密钥不匹配")
            aes_key = key.decrypt(decode(header.get("wrappedKey"), 384), padding.OAEP(
                mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            if len(aes_key) != 32:
                raise ValueError("AES 密钥无效")
            cipher = Cipher(algorithms.AES(aes_key), modes.GCM(decode(header.get("iv"), 12), decode(header.get("tag"), 16))).decryptor()
            cipher.authenticate_additional_data(MAGIC + b":" + key_id.encode("ascii"))
            # 失败时删除私有临时文件，只在 GCM 认证通过后发布解密结果。
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
                os.link(temp_name, target)  # 原子创建，不覆盖已有输出文件。
        return target
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


class ChineseArgumentParser(argparse.ArgumentParser):
    """统一显示中文帮助和参数错误，不暴露输入文件或私钥内容。"""

    def format_usage(self):
        return super().format_usage().replace("usage:", "用法：", 1)

    def format_help(self):
        return super().format_help().replace("usage:", "用法：", 1)

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(2, "参数错误，请检查必填项或使用 --help 查看说明。\n")


def main():
    parser = ChineseArgumentParser(description=__doc__, add_help=False)
    parser._positionals.title = "位置参数"
    parser._optionals.title = "选项"
    parser.add_argument("-h", "--help", action="help", help="显示帮助并退出")
    parser.add_argument("input", metavar="日志文件", help="从 OJ 下载的最终 .hplog 文件")
    parser.add_argument("--private-key", required=True, metavar="私钥文件", help="RSA 日志私钥 PEM 或 OJ 导出的密钥 JSON")
    parser.add_argument("-o", "--output", metavar="输出文件", help="输出 .log 路径，默认使用输入文件同名的 .log")
    parser.add_argument("--key-id", metavar="日志keyId", help="可选的预期日志 keyId，须为 32 位字符")
    parser.add_argument("--password", action="store_true", help="交互输入加密 PEM 的密码")
    parser.add_argument("--force", action="store_true", help="校验成功后覆盖已有输出文件")
    args = parser.parse_args()
    try:
        target = decrypt(args.input, args.private_key, args.output, args.key_id, args.force, args.password)
    except InvalidTag:
        print("解密失败：日志认证未通过，文件可能损坏或被篡改。", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print("解密失败：请检查文件格式、日志私钥及 keyId、密码和输出路径。", file=sys.stderr)
        return 1
    print(f"日志已解密：{target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
