import { useEffect, useRef, useState } from "react";
import { useService } from "@yeatz/app-framework/react";
import type { DesktopApi, DownloadCleanup, DownloadCleanupPreview } from "@media-marshal/contracts";
import { DesktopClient } from "../desktop-client";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";

const phases: Record<DownloadCleanup["phase"], string> = {
  PENDING: "等待内容核验",
  WAITING_REFERENCES: "等待其他任务释放原件",
  CLAIMED: "正在核验原件",
  QUARANTINED: "已隔离，等待最终核验",
  REMOVING: "正在清理原件",
  SOURCE_REMOVED: "下载原件已清理",
  CACHE_PENDING: "正在回收临时资源",
  DONE: "清理完成",
  NEEDS_ATTENTION: "清理需要处理",
};
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : value >= 1024 ** 3
        ? `${(value / 1024 ** 3).toFixed(2)} GiB`
        : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "清理记录读取失败，请刷新后重试";
type CleanupClient = Pick<
  DesktopApi,
  | "listDownloadCleanup"
  | "getDownloadCleanupScope"
  | "previewDownloadCleanup"
  | "getDownloadCleanupPreview"
  | "confirmDownloadCleanup"
  | "cancelDownloadCleanupPreview"
  | "retryDownloadCleanup"
>;

export function DownloadCleanupPanel({ taskId }: { taskId?: string }) {
  const client = useService(DesktopClient);
  return <DownloadCleanupContent key={taskId ?? "all"} client={client} taskId={taskId} />;
}

export function DownloadCleanupContent({
  client,
  taskId,
}: {
  client: CleanupClient;
  taskId?: string;
}) {
  const storageKey = `media-marshal.cleanup-preview.${taskId ?? "all"}`;
  const [items, setItems] = useState<DownloadCleanup[]>([]),
    [scope, setScope] = useState<Awaited<
      ReturnType<CleanupClient["getDownloadCleanupScope"]>
    > | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<DownloadCleanupPreview | null>(null),
    [previewId, setPreviewId] = useState(() => sessionStorage.getItem(storageKey));
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1),
    [scopePage, setScopePage] = useState(1);
  const mounted = useRef(true),
    lock = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = ++generation.current;
    const poll = async () => {
      try {
        const [rows, current] = await Promise.all([
          client.listDownloadCleanup({ taskId, page }),
          previewId ? client.getDownloadCleanupPreview(previewId) : Promise.resolve(null),
        ]);
        if (mounted.current && generation.current === epoch) {
          setItems(rows);
          setPreview(current);
        }
      } catch (failure) {
        if (mounted.current && generation.current === epoch) setError(message(failure));
      }
      if (mounted.current && generation.current === epoch)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    };
    void poll();
    return () => {
      mounted.current = false;
      ++generation.current;
      clearTimeout(timer);
    };
  }, [client, taskId, page, previewId]);
  const command = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (mounted.current) setError(message(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const remember = (id: string | null) => {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
    if (mounted.current) setPreviewId(id);
  };
  const loadScope = (next = 1) =>
    command(async () => {
      const rows = await client.getDownloadCleanupScope({ taskId, page: next });
      if (mounted.current) {
        setScope(rows);
        setScopePage(next);
        setSelected([]);
      }
    });
  const canConfirm = preview?.state === "READY" && preview.expiresAt > Date.now();
  return (
    <section className="panel download-cleanup-panel" aria-label="下载副本与临时资源">
      <h2>下载副本与临时资源</h2>
      <p className="cloud-hint">
        受管下载在媒体库完整内容核验通过、其他任务释放需求后逐项清理。字幕、图片和 NFO
        单独核验；未交付或内容不同的文件保留。普通本地输入和外部文件不在清理范围。
      </p>
      <ErrorNotice message={error} />
      {!items.length && (
        <p className="cloud-hint">
          此范围暂无清理记录。历史下载副本需先选择文件并预览，不会因打开页面而删除。
        </p>
      )}
      <ul className="download-cleanup-list">
        {items.map((item) => (
          <li key={item.id}>
            <div className="content-review-heading">
              <strong>{phases[item.phase]}</strong>
              <span>
                已释放 {bytes(item.freedBytes)} / {bytes(item.size)}
              </span>
            </div>
            <p className="settings-mapping-path">
              {item.kind === "TEMPORARY" ? "暂存文件" : "下载原件"}：{item.sourcePath}
            </p>
            <p className="settings-mapping-path">
              {item.kind === "TEMPORARY" ? "所属受管目录" : "媒体库副本"}：{item.targetPath}
            </p>
            {item.waitingReason && (
              <p role="status" className="cloud-hint">
                {item.waitingReason}
              </p>
            )}
            {item.failure && (
              <p role="alert" className="notice notice-error">
                {item.failure}
              </p>
            )}
            {item.phase === "NEEDS_ATTENTION" && item.kind !== "TEMPORARY" && (
              <p className="cloud-hint">重试会重新核验上方同一原件、媒体库副本及当前 Emby 关联。</p>
            )}
            {item.phase === "NEEDS_ATTENTION" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void command(async () => {
                    await client.retryDownloadCleanup(item.id);
                    const rows = await client.listDownloadCleanup({ taskId, page });
                    if (mounted.current) setItems(rows);
                  });
                }}
              >
                重试此项清理
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(page > 1 || items.length === 100) && (
        <div className="download-controls">
          <Button variant="outline" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>
            上一页清理记录
          </Button>
          <span>第 {page} 页</span>
          <Button
            variant="outline"
            disabled={busy || items.length < 100}
            onClick={() => setPage(page + 1)}
          >
            下一页清理记录
          </Button>
        </div>
      )}
      <details className="download-cleanup-history" open={!!previewId || scope !== null}>
        <summary>清理历史下载副本</summary>
        <p className="cloud-hint">
          只选择有成功同步收据的受管原件。预览会完整读取下载与媒体库文件，确认后再检查当前授权及共享需求。
        </p>
        {!previewId && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void loadScope();
            }}
          >
            选择历史清理范围
          </Button>
        )}
        {scope && !previewId && (
          <>
            {!scope.length && <p>本页没有可选择的受管副本。</p>}
            <ul className="download-cleanup-list">
              {scope.map((item) => (
                <li key={item.receiptId}>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={selected.includes(item.receiptId)}
                      onChange={(event) =>
                        setSelected((old) =>
                          event.target.checked
                            ? [...old, item.receiptId]
                            : old.filter((id) => id !== item.receiptId),
                        )
                      }
                    />
                    <span className="settings-mapping-path">
                      {item.sourcePath} · {bytes(item.size)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="download-controls">
              <Button
                variant="outline"
                disabled={busy || scopePage <= 1}
                onClick={() => {
                  void loadScope(scopePage - 1);
                }}
              >
                上一页历史文件
              </Button>
              <span>
                第 {scopePage} 页 · 已选 {selected.length} 项
              </span>
              <Button
                variant="outline"
                disabled={busy || scope.length < 50}
                onClick={() => {
                  void loadScope(scopePage + 1);
                }}
              >
                下一页历史文件
              </Button>
              <Button
                disabled={busy || !selected.length}
                onClick={() => {
                  void command(async () => {
                    const result = await client.previewDownloadCleanup({
                      receiptIds: selected,
                      requestKey: crypto.randomUUID(),
                    });
                    remember(result.id);
                    if (mounted.current) setPreview(result);
                  });
                }}
              >
                预览所选清理范围
              </Button>
            </div>
          </>
        )}
        {preview && (
          <div className="download-cleanup-preview" aria-label="历史清理预览">
            <h3>
              {preview.state === "PREPARING"
                ? "正在核验清理范围…"
                : preview.state === "READY"
                  ? `待确认清理 ${preview.items.length} 项`
                  : preview.state === "CONFIRMED"
                    ? "清理已提交"
                    : "本次预览不能提交"}
            </h3>
            {preview.failure && (
              <p className="notice notice-error" role="alert">
                {preview.failure}
              </p>
            )}
            <ul className="download-cleanup-list">
              {preview.items.map((item) => (
                <li key={item.receiptId}>
                  <p className="settings-mapping-path">
                    将清理：{item.sourcePath} · {bytes(item.size)}
                  </p>
                  <p className="settings-mapping-path">保留媒体库副本：{item.targetPath}</p>
                </li>
              ))}
            </ul>
            {preview.state === "PREPARING" && (
              <p role="status">
                已核验 {preview.items.length}{" "}
                项，正在完整读取后续文件；可以离开页面，重新打开后查询原预览。
              </p>
            )}
            {preview.state === "READY" && (
              <p className="cloud-hint">
                确认后在后台重新核验，只清理上述受管副本及有所有权记录的临时资源。到期时间：
                {new Date(preview.expiresAt).toLocaleString()}。
              </p>
            )}
            {preview.state === "EXPIRED" && <p>预览已过期，请取消后重新选择范围。</p>}
            <div className="download-controls">
              {["PREPARING", "READY", "BLOCKED", "EXPIRED"].includes(preview.state) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void command(async () => {
                      await client.cancelDownloadCleanupPreview(preview.id);
                      remember(null);
                      if (mounted.current) {
                        setPreview(null);
                        setScope(null);
                        setSelected([]);
                      }
                    });
                  }}
                >
                  取消本次预览
                </Button>
              )}
              {preview.state === "READY" && (
                <Button
                  disabled={busy || !canConfirm}
                  onClick={() => {
                    void command(async () => {
                      await client.confirmDownloadCleanup(preview.id);
                      const current = await client.getDownloadCleanupPreview(preview.id);
                      if (mounted.current) setPreview(current);
                    });
                  }}
                >
                  确认清理上述下载副本
                </Button>
              )}
              {["CONFIRMED", "CANCELLED"].includes(preview.state) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    remember(null);
                    setPreview(null);
                    setScope(null);
                  }}
                >
                  关闭预览结果
                </Button>
              )}
            </div>
          </div>
        )}
        {busy && <p role="status">正在提交，请稍候…</p>}
      </details>
    </section>
  );
}

export function DownloadCleanupNotice() {
  return (
    <p className="cloud-hint">
      受管下载的原件将在媒体库完整摘要核验通过、共享需求释放后清理，并回收本次临时资源。字幕、图片、NFO
      分别核验；未交付或内容不同的文件保留。普通本地来源继续保留原件。
    </p>
  );
}
