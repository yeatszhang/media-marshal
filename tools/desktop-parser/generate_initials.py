"""从固定 pinyin4j 字典生成首读音首字母表；构建及运行均不需要 Java。"""
from pathlib import Path
import hashlib
import json
import re
import urllib.request

REVISION = "8a05f77d7c980aa21f6dd1c6c3911d790ddd7924"
SOURCE = f"https://raw.githubusercontent.com/belerweb/pinyin4j/{REVISION}/src/main/resources/pinyindb/unicode_to_hanyu_pinyin.txt"
SHA256 = "f41a310ae6874351a4abf65d6d7aa4b80bee13c88a71d5ee601981d422d1cca6"
root = Path(__file__).resolve().parents[2]
data = urllib.request.urlopen(SOURCE, timeout=30).read()
if hashlib.sha256(data).hexdigest() != SHA256:
    raise SystemExit("固定拼音数据摘要不符")
groups = {}
for line in data.decode("utf-8").splitlines():
    match = re.fullmatch(r"([0-9A-F]+) \(([^)]+)\)", line)
    if not match:
        raise SystemExit("固定拼音数据格式无效")
    point = int(match[1], 16)
    first = match[2].split(",")[0]
    if 0x4E00 <= point <= 0x9FFF and first != "none0":
        initial = first[0].upper()
        if not re.fullmatch("[A-Z]", initial):
            raise SystemExit("固定拼音数据首字母无效")
        groups[initial] = groups.get(initial, "") + chr(point)
output = root / "packages/media-core/src/domain/pinyin-initials.ts"
output.write_text("// 生成文件；来源、许可和重建方式见 pinyin4j-NOTICE.txt。\nexport const pinyinInitialGroups: Readonly<Record<string, string>> = " + json.dumps(groups, ensure_ascii=False, indent=2) + ";\n")
notice = f"""pinyin4j 首字母派生数据

上游项目：https://github.com/belerweb/pinyin4j
固定源码：{REVISION}
固定字典：{SOURCE}
字典 SHA-256：{SHA256}

上游 PinyinHelper.java 声明 GPL-2.0-or-later，作者 Li Min。
本项目仅提取 CJK Unified Ideographs 单字首读音的 ASCII 首字母，
保留原字典顺序，不做上下文多音字推断；派生数据按 GPL-3.0 分发，
完整许可证见随包 media-marshal.LICENSE。
资源不包含 Java 字节码或运行时。可重复生成：
python3 tools/desktop-parser/generate_initials.py
"""
(root / "apps/desktop/resources/pinyin4j-NOTICE.txt").write_text(notice)
print(f"已核验并生成 {sum(map(len, groups.values()))} 个汉字的首字母，不输出字典正文")
