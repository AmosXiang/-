import { useEffect, useState } from "react";

// P1 hash 路由:页面与实体 id 以 URL 为唯一真相源,刷新后按 URL 恢复。
// 路由表:
//   #/library          素材库(首页,默认路由)
//   #/analysis/demo    拉片工作台 · 内置演示样本
//   #/analysis/:id     拉片工作台 · 指定视频记录
//   #/studio           创意项目列表
//   #/studio/new       创意工作室 · 新建(以当前选中影片为模板)
//   #/studio/:id       创意工作室 · 指定项目
export type AnalysisTab = "shots" | "characters" | "narrative";

export type Route =
  | { page: "library" }
  | { page: "analysis"; videoId: string; tab?: AnalysisTab }
  | { page: "studio"; projectId?: string };

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = clean.split("?");
  const [seg, ...rest] = pathPart.split("/");
  const id = rest.join("/");
  if (seg === "analysis" && id) {
    const tabRaw = new URLSearchParams(queryPart || "").get("tab");
    const tab: AnalysisTab | undefined =
      tabRaw === "characters" || tabRaw === "narrative" || tabRaw === "shots" ? tabRaw : undefined;
    return { page: "analysis", videoId: decodeURIComponent(id), tab };
  }
  if (seg === "studio") return id ? { page: "studio", projectId: decodeURIComponent(id) } : { page: "studio" };
  return { page: "library" };
}

export function navigateTo(hash: string) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    // 空 hash 归一化为 #/library,让默认落地页也有可分享/可刷新的 URL
    if (!window.location.hash) window.history.replaceState(null, "", "#/library");
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
