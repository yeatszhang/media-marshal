import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { SlidersHorizontal, ShieldCheck, Check } from "lucide-react";
import { SettingsViewModel } from "../services";
import { Header, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";
import i18n from "../i18n";
import { LibrarySetup } from "./LibrarySetup";

export function SettingsPage() {
  const { t } = useTranslation();
  const model = useService(SettingsViewModel);
  const { settings, error, loading } = useServiceState(model, (state) => state);
  const [embyUrl, setEmbyUrl] = useState(""),
    [tmdbProxy, setProxy] = useState(""),
    [keys, setKeys] = useState({ tmdb: "", emby: "" }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void model.refresh();
  }, [model]);
  useEffect(() => {
    if (settings) {
      setEmbyUrl(settings.embyUrl);
      setProxy(settings.tmdbProxy);
    }
  }, [settings]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await model.save({
        embyUrl,
        tmdbProxy,
        language: i18n.language === "en" ? "en" : "zh-CN",
      });
      setNotice(t("saved"));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Header title={t("settings")} description={t("setupHelp")} />
      <section className="panel download-job"><h2>手动整包升级与恢复</h2><p>升级前先停写并保存业务库、凭据密文和组件私有状态。备份不包含下载文件或媒体库；恢复后应用退出，需使用匹配版本。</p><div className="download-controls"><Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void model.prepareUpgrade().finally(() => setBusy(false)); }}>准备升级并退出</Button><Button variant="outline" disabled={busy} onClick={() => { void model.restoreUpgrade(); }}>恢复升级备份…</Button></div></section>
      <ErrorNotice
        message={error}
        retry={() => {
          void model.refresh();
        }}
      />
      {loading && !settings ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          <form className="panel settings-form" onSubmit={submit}>
            <div className="panel-heading">
              <SlidersHorizontal size={19} />
              <h2>{t("setupTitle")}</h2>
            </div>
            <label>
              {t("embyUrl")}
              <input
                type="url"
                placeholder="http://localhost:8096"
                value={embyUrl}
                onChange={(e) => setEmbyUrl(e.target.value)}
              />
            </label>
            <label>
              {t("tmdbProxy")}
              <input
                type="url"
                placeholder="http://127.0.0.1:7890"
                value={tmdbProxy}
                onChange={(e) => setProxy(e.target.value)}
              />
            </label>
            <label>
              {t("language")}
              <select
                value={i18n.language === "en" ? "en" : "zh-CN"}
                onChange={(e) => {
                  void i18n.changeLanguage(e.target.value);
                }}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <div className="form-actions">
              <Button type="submit" disabled={busy}>
                {t(busy ? "saving" : "save")}
              </Button>
            </div>
          </form>
          <section className="panel settings-form">
            <div className="panel-heading">
              <ShieldCheck size={19} />
              <h2>API Key</h2>
            </div>
            {(["tmdb", "emby"] as const).map((kind) => (
              <div className="key-field" key={kind}>
                <label>
                  {t(kind === "tmdb" ? "tmdbKey" : "embyKey")}
                  <span className="field-hint">
                    {t(
                      settings?.[
                        kind === "tmdb"
                          ? "tmdbKeyConfigured"
                          : "embyKeyConfigured"
                      ]
                        ? "configured"
                        : "notConfigured",
                    )}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={keys[kind]}
                    onChange={(e) =>
                      setKeys({ ...keys, [kind]: e.target.value })
                    }
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={!keys[kind] || busy}
                  onClick={() => {
                    setBusy(true);
                    void model
                      .saveKey(kind, keys[kind])
                      .then(() => {
                        setKeys((old) => ({ ...old, [kind]: "" }));
                        setNotice(t("keySaved"));
                      })
                      .catch(() => {})
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("saveKey")}
                </Button>
              </div>
            ))}
          </section>
          <LibrarySetup />
          <section className="panel settings-form">
            <div className="panel-heading"><h2>{t("diagnosticsTitle")}</h2></div>
            <p>{t("diagnosticsHelp")}</p>
            <Button variant="outline" disabled={busy} onClick={() => {
              setBusy(true);
              void model.exportDiagnostics().then((saved) => { if (saved) setNotice(t("diagnosticsSaved")); }).catch(() => {}).finally(() => setBusy(false));
            }}>{t("diagnosticsExport")}</Button>
          </section>
        </>
      )}
      {notice && (
        <div className="notice notice-success" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
    </>
  );
}
