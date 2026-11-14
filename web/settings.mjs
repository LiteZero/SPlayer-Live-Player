import { defaultRenderer, renderers } from "./renderers.mjs";
import { applyLayout, layoutFields, layoutTargets, normalizeLayout } from "../shared/layout.mjs";

const element = (id) => document.getElementById(id);
const labels = {
  host_waiting: "等待采集插件发送状态", host_disconnected: "宿主已断连或插件已停用",
  no_track: "宿主已连接，暂无曲目", lyric_waiting: "宿主已连接，等待确认歌词归属",
  lyric_none: "宿主已连接，当前曲目没有歌词", lyric_ready: "宿主已连接，歌词已就绪",
};
const selector = element("renderer");
for (const [id, { label }] of renderers) selector.add(new Option(label, id));
selector.value = defaultRenderer;
const url = element("url");
const preview = element("preview");
function showPreview() {
  const address = new URL("/obs", location.href);
  if (selector.value !== defaultRenderer) address.searchParams.set("renderer", selector.value);
  url.value = element("open").href = preview.src = address.href;
}
selector.addEventListener("change", showPreview);
showPreview();
element("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(url.value);
    element("copy").textContent = "已复制";
  } catch {
    url.select();
    element("copy").textContent = "已选中，请手动复制";
  }
});

const layoutForm = element("layout-form");
const layoutControls = element("layout-controls");
const layoutStatus = element("layout-status");
const saveLayout = element("save-layout");
const layoutRows = element("layout-rows");
const fieldLabels = { scale: "大小", x: "横向位移", y: "纵向位移" };
const layoutInputs = Object.entries(layoutTargets).map(([target, label]) => {
  const row = layoutRows.insertRow();
  const heading = document.createElement("th");
  heading.scope = "row";
  heading.textContent = label;
  row.append(heading);
  const fields = Object.entries(layoutFields).map(([field, { min, max }]) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = min;
    input.max = max;
    input.step = 1;
    input.name = `${target}-${field}`;
    input.required = true;
    input.setAttribute("aria-label", `${label} ${fieldLabels[field]} (%)`);
    row.insertCell().append(input);
    return [field, input];
  });
  return [target, fields];
});
let savedLayoutKey;
let draftLayout;

function updateLayoutPreview() {
  const dirty = draftLayout && JSON.stringify(draftLayout) !== savedLayoutKey;
  const output = preview.contentDocument?.getElementById("output");
  if (output) applyLayout(output, dirty ? draftLayout : null);
  saveLayout.disabled = !dirty;
  return dirty;
}

function fillLayout(layout) {
  for (const [target, fields] of layoutInputs) {
    for (const [field, input] of fields) input.value = layout[target][field];
  }
  draftLayout = layout;
  return updateLayoutPreview();
}

async function loadLayout() {
  try {
    const response = await fetch("/api/layout");
    if (!response.ok) throw new Error();
    const layout = await response.json();
    savedLayoutKey = JSON.stringify(layout);
    fillLayout(layout);
    layoutControls.disabled = false;
  } catch {
    layoutStatus.textContent = "无法读取布局，请刷新设置页重试。";
  }
}

preview.addEventListener("load", updateLayoutPreview);
layoutForm.addEventListener("input", () => {
  const layout = normalizeLayout(Object.fromEntries(layoutInputs.map(([target, fields]) => [
    target, Object.fromEntries(fields.map(([field, input]) => [field, input.valueAsNumber])),
  ])));
  if (!layout) {
    saveLayout.disabled = true;
    layoutStatus.textContent = "请输入范围内的整数。";
    return;
  }
  draftLayout = layout;
  layoutStatus.textContent = updateLayoutPreview() ? "有未保存的布局修改。" : "";
});
element("reset-layout").addEventListener("click", () => {
  layoutStatus.textContent = fillLayout(normalizeLayout({})) ? "保存后恢复默认布局。" : "";
});
layoutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (layoutControls.disabled || saveLayout.disabled) return;
  layoutControls.disabled = true;
  layoutStatus.textContent = "正在保存布局…";
  try {
    const response = await fetch("/api/layout", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftLayout),
    });
    if (!response.ok) throw new Error();
    const layout = await response.json();
    const previewDocument = preview.contentDocument;
    if (previewDocument?.getElementById("output")) applyLayout(previewDocument.documentElement, layout);
    savedLayoutKey = JSON.stringify(layout);
    fillLayout(layout);
    layoutStatus.textContent = "布局已保存并应用。";
  } catch {
    layoutStatus.textContent = "布局保存失败，请检查本地服务后重试。";
  } finally {
    layoutControls.disabled = false;
  }
});
loadLayout();

const cssEditor = element("custom-css");
const saveStyle = element("save-style");
const clearStyle = element("clear-style");
const styleStatus = element("style-status");
let savedCss = "";

async function loadStyle() {
  try {
    const response = await fetch("/obs-custom.css");
    if (!response.ok) throw new Error();
    savedCss = cssEditor.value = await response.text();
    cssEditor.disabled = saveStyle.disabled = clearStyle.disabled = false;
  } catch {
    styleStatus.textContent = "无法读取自定义 CSS，请刷新设置页重试。";
  }
}

cssEditor.addEventListener("input", () => {
  styleStatus.textContent = cssEditor.value === savedCss ? "" : "有未保存的修改";
});
clearStyle.addEventListener("click", () => {
  cssEditor.value = "";
  styleStatus.textContent = "保存后恢复默认样式。";
  cssEditor.focus();
});
element("style-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saveStyle.disabled) return;
  const css = cssEditor.value;
  saveStyle.disabled = true;
  styleStatus.textContent = "正在保存…";
  try {
    const response = await fetch("/api/style", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ css }),
    });
    if (response.status === 413) {
      styleStatus.textContent = "样式过长，请缩减到 64 KiB 以内。";
    } else if (!response.ok) {
      throw new Error();
    } else {
      savedCss = css;
      styleStatus.textContent = cssEditor.value !== savedCss ? "已保存，编辑框还有未保存的修改。"
        : css ? "已保存并应用。" : "已恢复默认样式。";
    }
  } catch {
    styleStatus.textContent = "保存失败，请检查本地服务后重试。";
  } finally {
    saveStyle.disabled = false;
  }
});
loadStyle();

let poll;
let request;
let traceKey;
async function update() {
  const current = new AbortController();
  request = current;
  const timeout = setTimeout(() => current.abort(), 1800);
  try {
    const response = await fetch("/api/status", { signal: current.signal });
    if (!response.ok) throw new Error(String(response.status));
    const state = await response.json();
    if (request !== current) return;
    element("backend").textContent = "已启动";
    element("host").textContent = labels[state.status] ?? state.status;
    element("track").textContent = state.track
      ? [state.track.title, ...state.track.artists].filter(Boolean).join(" · ") : "—";
    element("metrics").textContent = state.metrics
      ? `${state.lineCount} 行 · 全文 ${state.metrics.documents} 次 · 进度 ${state.metrics.samples} 次 · 共 ${state.metrics.bytes} 字节` : "—";
    const key = `${state.serverId}/${state.session?.sessionId}/${state.trace.at(-1)?.n}`;
    if (key !== traceKey) {
      traceKey = key;
      element("trace").textContent = state.trace.slice(-30).reverse().map((item) =>
        `+${item.elapsedMs} ms  ${item.event}  ${item.track ?? ""}  ${item.detail ?? ""}`.trimEnd()).join("\n") || "暂无事件";
    }
  } catch {
    if (request !== current) return;
    element("backend").textContent = "后端未启动或连接已中断";
    for (const id of ["host", "track", "metrics"]) element(id).textContent = "—";
  } finally {
    clearTimeout(timeout);
    if (request === current) {
      request = undefined;
      poll = setTimeout(update, 1500);
    }
  }
}
function suspend() {
  clearTimeout(poll);
  const old = request;
  request = undefined;
  old?.abort();
}
window.addEventListener("pagehide", suspend);
window.addEventListener("pageshow", (event) => { if (event.persisted) update(); });
update();
