import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useSourceRules } from "../source-draft-context";

/** 保留旧链接定位，所有配置编辑均进入来源页。 */
export function Subscriptions() {
  const { model } = useSourceRules(), navigate = useNavigate(), { id } = useParams(), [query] = useSearchParams(), legacyId = id ?? query.get("id");
  useEffect(() => {
    let active = true;
    const redirect = async () => {
      if (legacyId) await model.openLegacy("subscription", legacyId);
      else model.legacyNotice("目录订阅已并入来源配置，可在网盘来源中设置周期扫描、立即扫描和暂停来源。");
      if (active) navigate("/sources", { replace: true });
    }; void redirect(); return () => { active = false; };
  }, [model, navigate, legacyId]);
  return <p role="status">正在定位统一来源…</p>;
}
