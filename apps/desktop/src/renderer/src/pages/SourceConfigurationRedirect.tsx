import { useEffect, useState } from "react";
import { useService } from "@yeatz/app-framework/react";
import { Navigate, useSearchParams } from "react-router-dom";
import { DesktopClient } from "../desktop-client";
import { ErrorNotice } from "../components/shared";

// 下载历史可能属于新同步规则或尚未接管的旧配置，按实际所有权定位入口。
export function SourceConfigurationRedirect() {
  const client = useService(DesktopClient), [query] = useSearchParams(), source = query.get("source"), [destination, setDestination] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => { let live = true; setDestination(null); setError(null); void client.listSyncSources({ includeDeleted: true }).then((rows) => { if (live) setDestination(!source ? "/sources" : rows.some((row) => row.id === source && row.runtime?.claimed) ? `/sources?source=${encodeURIComponent(source)}` : `/sources/legacy?source=${encodeURIComponent(source)}`); }).catch((error) => { if (live) setError(error instanceof Error ? error.message : "无法定位原来源配置，请重试"); }); return () => { live = false; }; }, [client, source, retry]);
  return destination ? <Navigate to={destination} replace /> : error ? <ErrorNotice message={error} retry={() => setRetry((value) => value + 1)} /> : <p role="status">正在定位原来源配置…</p>;
}
