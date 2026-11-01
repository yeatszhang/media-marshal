import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// 清单核对来源完整性和可执行证据定位；实际业务断言由各测试运行器执行。
const inventory = JSON.parse(await readFile(new URL("../openspec/changes/migrate-complete-recognition-strategies/legacy-test-inventory.json", import.meta.url), "utf8"));
let count = 0, adaptations = 0;
for (const source of inventory.sources) {
  const contents = await readFile(source.source, "utf8");
  assert.equal(createHash("sha256").update(contents).digest("hex"), source.sha256, `${source.source} 的来源快照已变化`);
  const expression = source.source.endsWith(".java") ? /@(?:Test|ParameterizedTest)(?:(?!@(?:Test|ParameterizedTest))[\s\S])*?\bvoid\s+(\w+)\s*\(/g : source.source.endsWith(".py") ? /def\s+(test_\w+)\s*\(/g : /test\('([^']+)'/g;
  const original = [...contents.matchAll(expression)].map((match) => match[1]);
  assert.deepEqual(source.cases.map((item) => item.name), original, `${source.source} 缺少或重复记录原测试`);
  for (const item of source.cases) {
    const [file, marker] = item.verification.split("::");
    assert.ok(file && marker, `${item.name} 缺少验证定位`);
    assert.ok((await readFile(file, "utf8")).includes(marker), `${item.name} 的验证定位不存在：${item.verification}`);
    count++; if (item.adaptation) adaptations++;
  }
}
assert.equal(count, 175);
console.log(`识别行为对照通过：${inventory.sources.length} 个旧源文件，${count} 项用例，${adaptations} 项明确记录桌面适配差异。`);
