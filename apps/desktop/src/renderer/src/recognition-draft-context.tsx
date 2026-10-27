import { createContext, useContext, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { RecognitionRule, RecognitionRuleConfiguration } from "@media-marshal/contracts";
export interface RecognitionDraft { id: string; row: RecognitionRule | null; configuration: RecognitionRuleConfiguration; rebind: boolean; revision: number }
const Context = createContext<[RecognitionDraft | null, Dispatch<SetStateAction<RecognitionDraft | null>>] | null>(null);
export function RecognitionDraftProvider({ children }: { children: ReactNode }) { const state = useState<RecognitionDraft | null>(null); return <Context.Provider value={state}>{children}</Context.Provider>; }
export function useRecognitionDraft() { const value = useContext(Context); if (!value) throw new Error("识别表单需要根草稿上下文"); return value; }
