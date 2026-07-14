import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 全局错误边界:任何子树渲染异常时展示可恢复的报错面板,
 * 避免整个应用被 React 卸载成黑屏(P0 止血)。
 */
export default class ErrorBoundary extends React.Component {
  // 项目未安装 @types/react(react 导入无类型),手动声明基类成员类型
  declare props: { children?: unknown };
  declare setState: (state: ErrorBoundaryState) => void;
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] 渲染异常:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center p-6 font-sans">
        <div className="max-w-lg w-full bg-slate-900 border border-rose-900/60 rounded-2xl p-6 space-y-4 shadow-2xl">
          <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
            <span className="text-lg">⚠</span>
            <span>界面渲染出错了</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            某个面板在渲染时抛出了异常(通常由个别数据缺失引起)。你的项目数据已保存在本机数据库,不会丢失。
          </p>
          <details className="text-[11px] text-slate-500 bg-slate-950 rounded-lg p-3 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
            <summary className="cursor-pointer text-slate-400 mb-1">错误详情</summary>
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
          </details>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold"
            >
              尝试恢复
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold border border-slate-700/60"
            >
              重新加载页面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
