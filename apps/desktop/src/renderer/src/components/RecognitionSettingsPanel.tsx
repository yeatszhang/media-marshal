import { useEffect, useRef, useState, type FormEvent } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { useTranslation } from "react-i18next";
import { ScanSearch } from "lucide-react";
import { recognitionSettingsSchema, type CoreOutput } from "@media-marshal/contracts";
import { SettingsViewModel } from "../services";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
import "../codex-i18n";
import "./codex-recognition.css";

export function RecognitionSettingsPanel() {
  const { t } = useTranslation(), model = useService(SettingsViewModel), { settings } = useServiceState(model, (value) => value);
  const [draft, setDraft] = useState(() => recognitionSettingsSchema.parse(settings?.recognition ?? {})), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [usage, setUsage] = useState<CoreOutput<"codex.usage"> | null>(null);
  const edited = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (settings && !edited.current) setDraft(recognitionSettingsSchema.parse(settings.recognition ?? {})); }, [settings]);
  const change = (patch: Partial<typeof draft>) => { edited.current = true; setDraft((value) => ({ ...value, ...patch })); setNotice(null); setError(null); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!settings || busy) return;
    const checked = recognitionSettingsSchema.safeParse(draft);
    if (!checked.success) { setError(checked.error.issues.map((issue) => issue.message).join("；")); return; }
    setBusy(true); setError(null); setNotice(null);
    try { await model.save({ language: settings.language, embyUrl: settings.embyUrl, tmdbProxy: settings.tmdbProxy, recognition: checked.data }); if (alive.current) { edited.current = false; setNotice(t("codex.saved")); } }
    catch { /* 保存错误由设置页统一展示，保留当前草稿。 */ }
    finally { if (alive.current) setBusy(false); }
  };
  const readUsage = async () => {
    setReading(true); setError(null);
    try { const value = await model.client.getCodexUsage(); if (alive.current) setUsage(value); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "无法读取 Codex 用量，请重试"); }
    finally { if (alive.current) setReading(false); }
  };
  return <form className="panel settings-card" id="recognition-strategy" aria-labelledby="recognition-settings-title" onSubmit={(event) => { void save(event); }}>
    <div className="settings-card-heading"><ScanSearch size={19} aria-hidden="true" /><h2 id="recognition-settings-title">{t("codex.settings")}</h2></div>
    <div className="settings-body settings-rows">
      <ErrorNotice message={error} />
      <label className="check-label"><input type="checkbox" checked={draft.codexEnabled} disabled={busy || !settings} onChange={(event) => change({ codexEnabled: event.target.checked })} />{t("codex.enabled")}</label>
      <p className="cloud-hint">{t("codex.enabledHelp")}</p>
      <div className="settings-row"><label htmlFor="recognition-threshold">{t("codex.threshold")}</label><input id="recognition-threshold" type="number" min="0" max="100" step="1" disabled={busy || !settings} value={Math.round(draft.confidenceThreshold * 100)} onChange={(event) => change({ confidenceThreshold: Number(event.target.value) / 100 })} /></div>
      <div className="settings-row"><label htmlFor="recognition-daily-calls">{t("codex.dailyCalls")}</label><input id="recognition-daily-calls" type="number" min="1" max="1000" step="1" disabled={busy || !settings} value={draft.dailyCalls} onChange={(event) => change({ dailyCalls: Number(event.target.value) })} /></div>
      <details className="codex-settings-advanced"><summary>{t("codex.advanced")}</summary><div className="settings-rows">
        <div className="settings-row"><label htmlFor="recognition-cli-path">{t("codex.cliPath")}</label><input id="recognition-cli-path" value={draft.cliPath} disabled={busy || !settings} onChange={(event) => change({ cliPath: event.target.value })} spellCheck={false} /></div>
        <div className="settings-row"><label htmlFor="recognition-model">{t("codex.model")}</label><input id="recognition-model" value={draft.model} disabled={busy || !settings} onChange={(event) => change({ model: event.target.value })} spellCheck={false} /></div>
        <label className="check-label"><input type="checkbox" checked={draft.parentFolderEnabled} disabled={busy || !settings} onChange={(event) => change({ parentFolderEnabled: event.target.checked })} />{t("codex.parentEnabled")}</label>
        <div className="settings-row"><label htmlFor="recognition-parent-cap">{t("codex.parentCap")}</label><input id="recognition-parent-cap" type="number" min="0" max="100" disabled={busy || !settings} value={Math.round(draft.parentOnlyConfidenceCap * 100)} onChange={(event) => change({ parentOnlyConfidenceCap: Number(event.target.value) / 100 })} /></div>
        <div className="settings-row"><label htmlFor="recognition-parent-boost">{t("codex.parentBoost")}</label><input id="recognition-parent-boost" type="number" min="0" max="100" disabled={busy || !settings} value={Math.round(draft.parentMutualBoost * 100)} onChange={(event) => change({ parentMutualBoost: Number(event.target.value) / 100 })} /></div>
      </div></details>
      <p className="cloud-hint">{t("codex.rulesHelp")}</p>
      {notice && <p role="status" className="notice">{notice}</p>}
      {usage && <p role="status" className="cloud-hint codex-usage">{t("codex.usageSummary", { day: usage.day, calls: usage.calls, limit: usage.call_limit, input: usage.input_tokens, cached: usage.cached_input_tokens, output: usage.output_tokens })}</p>}
    </div>
    <div className="settings-footer settings-actions"><Button type="submit" disabled={busy || !settings}>{t(busy ? "codex.saving" : "codex.save")}</Button><Button type="button" variant="outline" disabled={reading || busy || !settings} onClick={() => { void readUsage(); }}>{t(reading ? "codex.usageLoading" : "codex.usage")}</Button></div>
  </form>;
}
