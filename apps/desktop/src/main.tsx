import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// macOS 下窗口使用 Overlay 标题栏（隐藏系统标题、红绿灯覆盖在内容上），
// 给根元素加标记类，便于 CSS 为顶部左侧内容做红绿灯避让
if (/^Mac|iPhone|iPad/.test(navigator.platform)) {
  document.documentElement.classList.add("macos-title-overlay");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
