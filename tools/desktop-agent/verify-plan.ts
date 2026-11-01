import { verifyChecks, verifyDescriptions, type VerifyCheck } from "./verify-catalog.ts";
export type BusinessScope = "all" | "core" | "renderer";
export interface VerificationChanges {
  files: string[];
  baseCommit: string;
  headCommit: string;
  truncated: boolean;
  standardsFiles: string[];
}
const common: VerifyCheck[] = ["architecture", "types"];
const full: VerifyCheck[] = [...verifyChecks];
const rootConfiguration =
  /^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.ts|\.npmrc|\.gitignore|\.prettier[^/]*|\.github\/)/;
interface Impact {
  checks: VerifyCheck[];
  reason: string;
  scope?: BusinessScope;
  unknown?: boolean;
}
function impact(file: string): Impact {
  if (file.startsWith("openspec/")) return { checks: ["specs", "docs"], reason: "规格或规划变化" };
  if (/(?:^|\/)AGENTS\.md$|^\.agents\/skills\//.test(file))
    return {
      checks: [...common, "tools", "desktop", "docs"],
      reason: "开发指引或 Skill 变化需要核对执行入口",
    };
  if (/^docs\/|\.mdx?$/.test(file)) return { checks: ["docs"], reason: "文档内容变化" };
  if (
    rootConfiguration.test(file) ||
    file.startsWith("packages/contracts/") ||
    file.startsWith("scripts/")
  )
    return {
      checks: full,
      reason: "共享契约、构建配置或工程脚本可能影响全部桌面路径",
      scope: "all",
    };
  if (file.startsWith("apps/desktop/src/renderer/"))
    return {
      checks: [...common, "business", "tools", "desktop"],
      reason: "Renderer 变更需要组件与真实交互核对",
      scope: "renderer",
    };
  if (file.startsWith("packages/media-core/"))
    return {
      checks: [
        ...common,
        "business",
        "tools",
        "desktop",
        "packaged",
        ...(file.includes("/files/") ? ["native" as const] : []),
      ],
      reason: "业务核心与持久状态需要核心、交互和安装态回归",
      scope: "core",
    };
  if (file.startsWith("tools/desktop-agent/"))
    return {
      checks: [
        ...common,
        "tools",
        "desktop",
        "packaged",
        ...(file.includes("/native/") || /native[-.]/.test(file.split("/").at(-1)!)
          ? ["native" as const]
          : []),
      ],
      reason: "开发驱动修改需要负例、手动上下文及发行资源隔离核对",
    };
  if (file.startsWith("apps/desktop/tests/"))
    return { checks: [...common, "desktop", "packaged"], reason: "桌面夹具或验收标准发生变化" };
  if (file.startsWith("apps/desktop/") || /^tools\/desktop-(?:files|parser|sidecars)\//.test(file))
    return { checks: full, reason: "宿主、桥接或原生资源变更需要完整桌面回归", scope: "all" };
  return { checks: full, reason: "未知路径回退当前桌面全量回归", scope: "all", unknown: true };
}
export function verificationPlan(changes: VerificationChanges, benchmark = false) {
  const selected = new Map<VerifyCheck, Set<string>>();
  const add = (checks: VerifyCheck[], reason: string) =>
    checks.forEach((id) => {
      if (!selected.has(id)) selected.set(id, new Set());
      selected.get(id)!.add(reason);
    });
  let unknownFallback = changes.truncated,
    core = false,
    renderer = false,
    broad = false;
  for (const file of changes.files) {
    const change = impact(file);
    add(change.checks, change.reason);
    core ||= change.scope === "core";
    renderer ||= change.scope === "renderer";
    broad ||= change.scope === "all";
    unknownFallback ||= change.unknown ?? false;
  }
  if (unknownFallback) {
    add(full, "存在未知路径或改动清单截断，回退当前桌面全量回归");
    broad = true;
  }
  if (benchmark) add(["benchmark"], "调用者明确要求测量当前设备");
  const scope: BusinessScope = broad || (core && renderer) ? "all" : renderer ? "renderer" : "core";
  const checks = verifyChecks
    .filter((id) => selected.has(id))
    .map((id) => ({
      id,
      description: verifyDescriptions[id],
      reasons: [...selected.get(id)!],
      status: "not-run" as const,
      required: true as const,
    }));
  const targets = new Set<"development" | "packaged">();
  if (checks.some((check) => ["tools", "desktop", "native"].includes(check.id)))
    targets.add("development");
  if (checks.some((check) => ["packaged", "benchmark"].includes(check.id))) targets.add("packaged");
  return {
    version: 1,
    status: "planned",
    execution: "not-run",
    allPlannedChecksPassed: false,
    scope: "current-desktop",
    unknownFallback,
    businessScope: scope,
    checks,
    requiredBuilds: [...targets],
    changes,
    standards: {
      changedFiles: changes.standardsFiles,
      comparison: "file-diff-only",
      semanticEquivalence: changes.standardsFiles.length ? "unverified" : "unchanged",
      automaticBaselineAcceptance: false,
    },
    recommendations:
      selected.has("desktop") && !selected.has("benchmark")
        ? [
            {
              id: "benchmark",
              reason: "交互变化可补充性能样本，当前未纳入必跑范围",
              status: "not-run",
            },
          ]
        : [],
    releaseAcceptance: "not-run",
    historyComplete: false,
  };
}
export type VerificationPlan = ReturnType<typeof verificationPlan>;
