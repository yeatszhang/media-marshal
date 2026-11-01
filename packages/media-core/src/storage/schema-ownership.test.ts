import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CoreDatabase } from "../infrastructure/database";
const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../scripts/architecture/${name}`, import.meta.url), "utf8"),
  );
it("所有当前表和计划基线表均有唯一所有者，历史 DDL 和旧接管字段显式登记，成功及恢复事实不进入删除集", async () => {
  const owners = read("tables.json") as Record<string, string>;
  const lifecycle = read("table-lifecycle.json") as {
    historicalDdlOnly: string[];
    legacyTakeoverTables: string[];
    legacyTakeoverColumns: Record<string, string[]>;
    protectedFacts: string[];
    retainedIdentities: string[];
  };
  const db = await CoreDatabase.open(":memory:");
  try {
    const current = db.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(current.map((row) => row.name)).toEqual(
      Object.keys(owners)
        .filter((name) => !lifecycle.historicalDdlOnly.includes(name))
        .sort(),
    );
    const knownOwners = new Set([
      "configuration",
      "library",
      "sync",
      "ingestion",
      "corrections",
      "delivery",
      "retention",
    ]);
    for (const { name } of current) expect(knownOwners.has(owners[name]!)).toBe(true);
    for (const name of lifecycle.legacyTakeoverTables)
      expect(current.some((row) => row.name === name)).toBe(true);
    for (const name of [...lifecycle.protectedFacts, ...lifecycle.retainedIdentities]) {
      expect(current.some((row) => row.name === name)).toBe(true);
      expect(lifecycle.legacyTakeoverTables).not.toContain(name);
      expect(lifecycle.historicalDdlOnly).not.toContain(name);
    }
    for (const [table, columns] of Object.entries(lifecycle.legacyTakeoverColumns)) {
      const actual = db.connection.pragma(`table_info(${table})`) as { name: string }[];
      for (const column of columns) expect(actual.some((row) => row.name === column)).toBe(true);
    }
    const baseline = current.filter(({ name }) => !lifecycle.legacyTakeoverTables.includes(name));
    expect(new Set(baseline.map(({ name }) => name)).size).toBe(baseline.length);
  } finally {
    db.close();
  }
});
