import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { SourceRulesViewModel, emptySourceDraft, sourceView, type SourceDraftState } from "./source-rules-model";
const SourceDraftContext = createContext<SourceDraftState | null>(null);
/** React 根持有唯一编辑值；跨路由保留，整个 Renderer 重载后从核心重新读取已保存草稿。 */
export function SourceDraftProvider({ children }: { children: ReactNode }) {
  const model = useService(SourceRulesViewModel), [draft, setDraft] = useState(emptySourceDraft), current = useRef(draft);
  const binding = useMemo(() => ({ read: () => current.current, update: (patch: Partial<SourceDraftState>) => { const next = { ...current.current, ...patch }; current.current = next; setDraft(next); } }), []);
  useLayoutEffect(() => model.bindDraft(binding), [model, binding]);
  return <SourceDraftContext.Provider value={draft}>{children}</SourceDraftContext.Provider>;
}
export function useSourceRules() {
  const draft = useContext(SourceDraftContext), model = useService(SourceRulesViewModel), remote = useServiceState(model, (state) => state);
  if (!draft) throw new Error("来源表单必须在 React 草稿上下文中使用");
  return { model, state: sourceView(remote, draft) };
}
