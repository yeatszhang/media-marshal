"""验证固定资产准备器的完整性和归档边界。"""

import importlib.util
import io
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).resolve().parents[1] / "prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_corrupt_cache_is_rejected_without_download(self):
        cache = self.root / "archive.zip"
        cache.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "完整性"):
            prepare.download("https://example.invalid/archive.zip", cache, "0" * 64)
        self.assertEqual(cache.read_bytes(), b"corrupt")

    def test_tar_links_are_rejected(self):
        archive = self.root / "artifact.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            entry = tarfile.TarInfo("openlist")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
            package.addfile(entry)
        with self.assertRaisesRegex(ValueError, "类型或长度"):
            prepare.extract_binary(archive, "openlist", self.root / "out", 0)

    def test_zip_duplicate_member_is_rejected(self):
        archive = self.root / "artifact.zip"
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr("rclone", b"one")
            with self.assertWarns(UserWarning):
                package.writestr("rclone", b"two")
        with self.assertRaisesRegex(ValueError, "重复"):
            prepare.extract_binary(archive, "rclone", self.root / "out", 3)

    def test_only_pinned_regular_file_is_copied(self):
        archive = self.root / "artifact.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            for name, payload in [("openlist", b"binary"), ("../../escape", b"bad")]:
                entry = tarfile.TarInfo(name)
                entry.size = len(payload)
                package.addfile(entry, io.BytesIO(payload))
        output = self.root / "out"
        prepare.extract_binary(archive, "openlist", output, 6)
        self.assertEqual(output.read_bytes(), b"binary")
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["artifact.tar.gz", "out"])

    def test_member_length_and_path_must_match(self):
        archive = self.root / "artifact.zip"
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr("rclone", b"123")
        with self.assertRaisesRegex(ValueError, "长度"):
            prepare.extract_binary(archive, "rclone", self.root / "out", 4)
        for name in ["../rclone", "/rclone", "C:/rclone", "dir\\rclone"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                prepare.safe_member(name)


if __name__ == "__main__":
    unittest.main()
