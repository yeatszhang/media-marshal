import { createContext, useContext, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { SyncSourceConfiguration, SyncSourceRule } from "@media-marshal/contracts";
export interface SyncDraft { row: SyncSourceRule | null; id: string; configuration: SyncSourceConfiguration; remoteName: string | null; accountRoot: string | null; rebind: boolean; revision: number }
const Context = createContext<[SyncDraft | null, Dispatch<SetStateAction<SyncDraft | null>>] | null>(null);
/** 跨网盘登录路由保留尚未保存的表单；重载后显式读取核心草稿。 */
export function SyncDraftProvider({ children }: { children: ReactNode }) { const state = useState<SyncDraft | null>(null); return <Context.Provider value={state}>{children}</Context.Provider>; }
export function useSyncDraft() { const value = useContext(Context); if (!value) throw new Error("同步表单需要根草稿上下文"); return value; }
