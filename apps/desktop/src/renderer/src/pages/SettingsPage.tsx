import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import {
  SlidersHorizontal,
  ShieldCheck,
  Check,
  Activity,
  ArchiveRestore,
} from "lucide-react";
import { SettingsViewModel } from "../services";
import { Header, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";
import i18n from "../i18n";
import { HostSettingsPanel } from "../components/HostSettingsPanel";
import { LibrarySetup } from "./LibrarySetup";
import "./settings.css";

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
    <div className="settings-page">
      <Header title={t("settings")} description={t("setupHelp")} />
      <ErrorNotice
        message={error}
        retry={() => {
          void model.refresh();
        }}
      />
      {loading && !settings ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <div className="settings-sections">
          <form
            className="panel settings-card"
            aria-labelledby="settings-connection-title"
            onSubmit={submit}
          >
            <div className="settings-card-heading">
              <SlidersHorizontal size={19} aria-hidden="true" />
              <h2 id="settings-connection-title">{t("setupTitle")}</h2>
            </div>
            <div className="settings-body settings-rows">
              <div className="settings-row">
                <label htmlFor="settings-emby-url">{t("embyUrl")}</label>
                <input
                  id="settings-emby-url"
                  type="url"
                  placeholder="http://localhost:8096"
                  value={embyUrl}
                  onChange={(e) => { setEmbyUrl(e.target.value); setNotice(null); }}
                />
              </div>
              <div className="settings-row">
                <label htmlFor="settings-tmdb-proxy">{t("tmdbProxy")}</label>
                <input
                  id="settings-tmdb-proxy"
                  type="url"
                  placeholder="http://127.0.0.1:7890"
                  value={tmdbProxy}
                  onChange={(e) => { setProxy(e.target.value); setNotice(null); }}
                />
                <small className="settings-description settings-proxy-help">仅用于 TMDB 查询，支持 HTTP(S) 代理。留空表示直连；地址不包含账号、密码或子路径。</small>
              </div>
              <div className="settings-row">
                <label htmlFor="settings-language">{t("language")}</label>
                <select
                  id="settings-language"
                  className="settings-language"
                  value={i18n.language === "en" ? "en" : "zh-CN"}
                  onChange={(e) => {
                    void i18n.changeLanguage(e.target.value);
                  }}
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
            <div className="settings-footer settings-actions">
              <Button type="submit" disabled={busy}>
                {t(busy ? "saving" : "save")}
              </Button>
            </div>
          </form>
          <section
            className="panel settings-card"
            aria-labelledby="settings-keys-title"
          >
            <div className="settings-card-heading">
              <ShieldCheck size={19} aria-hidden="true" />
              <h2 id="settings-keys-title">API Key</h2>
            </div>
            <div className="settings-body settings-rows">
              {(["tmdb", "emby"] as const).map((kind) => (
                <div className="settings-row" key={kind}>
                  <div className="settings-field-caption">
                    <label htmlFor={`settings-${kind}-key`}>
                      {t(kind === "tmdb" ? "tmdbKey" : "embyKey")}
                    </label>
                    <span
                      id={`settings-${kind}-key-status`}
                      className={`settings-key-status${settings?.[kind === "tmdb" ? "tmdbKeyConfigured" : "embyKeyConfigured"] ? " is-configured" : ""}`}
                    >
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
                  </div>
                  <div className="settings-input-action">
                    <input
                      id={`settings-${kind}-key`}
                      aria-describedby={`settings-${kind}-key-status`}
                      type="password"
                      autoComplete="off"
                      value={keys[kind]}
                      onChange={(e) =>
                        setKeys({ ...keys, [kind]: e.target.value })
                      }
                    />
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
                </div>
              ))}
            </div>
          </section>
          <LibrarySetup />
          <HostSettingsPanel />
          <section
            className="panel settings-card"
            aria-labelledby="settings-diagnostics-title"
          >
            <div className="settings-card-heading">
              <Activity size={19} aria-hidden="true" />
              <h2 id="settings-diagnostics-title">{t("diagnosticsTitle")}</h2>
            </div>
            <div className="settings-body settings-utility">
              <p className="settings-description">{t("diagnosticsHelp")}</p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void model
                    .exportDiagnostics()
                    .then((saved) => {
                      if (saved) setNotice(t("diagnosticsSaved"));
                    })
                    .catch(() => {})
                    .finally(() => setBusy(false));
                }}
              >
                {t("diagnosticsExport")}
              </Button>
            </div>
          </section>
        </div>
      )}
      <section
        className="panel settings-card settings-maintenance"
        aria-labelledby="settings-upgrade-title"
      >
        <div className="settings-card-heading">
          <ArchiveRestore size={19} aria-hidden="true" />
          <h2 id="settings-upgrade-title">手动整包升级与恢复</h2>
        </div>
        <div className="settings-body">
          <p className="settings-description">
            升级前先停写并保存业务库、凭据密文和组件私有状态。备份不包含下载文件或媒体库；恢复后应用退出，需使用匹配版本。
          </p>
        </div>
        <div className="settings-footer settings-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void model.prepareUpgrade().finally(() => setBusy(false));
            }}
          >
            准备升级并退出
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void model.restoreUpgrade().finally(() => setBusy(false));
            }}
          >
            恢复升级备份…
          </Button>
        </div>
      </section>
      {notice && (
        <div className="notice notice-success" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
    </div>
  );
}
