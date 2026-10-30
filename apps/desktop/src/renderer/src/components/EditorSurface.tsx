import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";

/** 原生模态负责焦点隔离；草稿只在用户明确放弃后清理。 */
export function EditorSurface({ title, variant = "drawer", dirty, busy = false, onClose, children }: {
  title: string; variant?: "drawer" | "modal"; dirty: boolean; busy?: boolean;
  onClose(): void; children(requestClose: () => void): ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null), confirmation = useRef<HTMLDialogElement>(null);
  const lastError = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const element = dialog.current!, trigger = document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus({ preventScroll: true });
    return () => {
      element.close();
      requestAnimationFrame(() => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); });
    };
  }, []);
  useEffect(() => {
    if (!confirming) return;
    const element = confirmation.current!, previous = document.activeElement;
    element.showModal();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [confirming]);
  useEffect(() => {
    const alert = dialog.current?.querySelector<HTMLElement>('[role="alert"]');
    const message = alert?.textContent ?? null;
    if (message && message !== lastError.current) alert?.scrollIntoView?.({ block: "center" });
    lastError.current = message;
  });
  const requestClose = () => { if (!busy) { if (dirty) setConfirming(true); else onClose(); } };
  return <><dialog ref={dialog} className={`editor-surface editor-surface--${variant}`} aria-label={title} onCancel={(event) => { event.preventDefault(); requestClose(); }}>
    {children(requestClose)}
  </dialog>{confirming && <dialog ref={confirmation} className="source-lifecycle-dialog editor-discard" aria-label={t("editor.discardTitle")} onCancel={(event) => { event.preventDefault(); setConfirming(false); }}>
    <h2>{t("editor.discardTitle")}</h2><p>{t("editor.discardHelp")}</p><div className="form-actions"><Button autoFocus variant="outline" onClick={() => setConfirming(false)}>{t("editor.continue")}</Button><Button disabled={busy} onClick={() => { setConfirming(false); onClose(); }}>{t("editor.discard")}</Button></div>
  </dialog>}</>;
}
