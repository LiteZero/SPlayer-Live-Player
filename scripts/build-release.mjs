import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("首版免安装包请在 Windows x64、Node.js ≥ 22.12 下构建。");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error("应用版本格式无效");
await import("./build-plugin.mjs");
const pluginFile = join(root, "dist/splayer-live-lyrics.js");
const pluginVersion = (await readFile(pluginFile, "utf8")).match(/@version\s+(\S+)/)?.[1];
if (!pluginVersion) throw new Error("插件缺少版本标记");
const name = `SPlayer-Live-Player-v${pkg.version}-win-x64`;
const releases = join(root, "release");
await mkdir(releases, { recursive: true });
let output;
for (let attempt = 0; ; ++attempt) {
  output = join(releases, attempt ? `${name}-${attempt + 1}` : name);
  try { await mkdir(output); break; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const archive = output + ".zip";
const runtimeLicense = join(dirname(process.execPath), "LICENSE");
await stat(runtimeLicense);
for (const directory of ["backend", "runtime", "plugins", "scripts", "licenses"]) await mkdir(join(output, directory));
await build({
  absWorkingDir: root, entryPoints: ["backend/server.mjs"], outfile: join(output, "backend/server.mjs"),
  platform: "node", format: "esm", target: "node22.12", bundle: true, metafile: true,
  external: ["bufferutil", "utf-8-validate"], legalComments: "linked",
  banner: { js: 'import { createRequire as releaseCreateRequire } from "node:module"; const require = releaseCreateRequire(import.meta.url);' },
});
await Promise.all([
  cp(join(root, "web"), join(output, "web"), { recursive: true }),
  cp(join(root, "shared"), join(output, "shared"), { recursive: true }),
  copyFile(pluginFile, join(output, "plugins/splayer-live-lyrics.js")),
  copyFile(join(root, "scripts/launch.mjs"), join(output, "scripts/launch.mjs")),
  copyFile(process.execPath, join(output, "runtime/node.exe")),
  copyFile(runtimeLicense, join(output, "runtime/LICENSE")),
]);

// Include notices from every installed production dependency in the lockfile.
// Local account data, workspace settings, experiments and development tools are never copied.
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const dependencies = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || entry.dev || entry.devOptional) continue;
  const installed = join(root, path);
  const dependency = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const folder = dependency.name.replaceAll("/", "_").replaceAll("@", "");
  await mkdir(join(output, "licenses", folder), { recursive: true });
  const notices = (await readdir(installed)).filter((file) => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(file));
  for (const file of notices) await copyFile(join(installed, file), join(output, "licenses", folder, file));
  dependencies.push({ name: dependency.name, version: entry.version, license: dependency.license ?? entry.license ?? "参见许可证文件" });
}
await writeFile(join(output, "THIRD_PARTY_NOTICES.md"), `# 第三方组件\n\n运行环境 Node.js ${process.version} 的许可见 runtime/LICENSE。依赖许可原文见 licenses/，构建保留的声明见 backend/server.mjs.LEGAL.txt。\n\n` +
  dependencies.map((dep) => `- ${dep.name} ${dep.version}：${typeof dep.license === "string" ? dep.license : JSON.stringify(dep.license)}`).join("\n") + "\n");
const metadata = { name: pkg.name, version: pkg.version, pluginVersion, platform: "win32", arch: "x64",
  nodeVersion: process.version, builtAt: new Date().toISOString(), verification: "本地自动化与浏览器验证；真实 B 站点歌入队待人工验收" };
await writeFile(join(output, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
const launcher = '@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\ncd /d "%~dp0"\r\nif not exist "runtime\\node.exe" (\r\n  echo 未找到运行环境，请完整解压后再启动。\r\n  pause\r\n  exit /b 1\r\n)\r\n"runtime\\node.exe" "scripts\\launch.mjs"\r\nif errorlevel 1 pause\r\nendlocal\r\n';
await writeFile(join(output, "启动歌词设置.cmd"), launcher, "utf8");
await writeFile(join(output, "使用说明.txt"), `SPlayer Live Player v${pkg.version} · Windows x64 首版\r\n\r\n` +
  `1. 将整个压缩包解压到可写文件夹，不要直接在压缩包内启动。\r\n` +
  `2. 双击「启动歌词设置.cmd」。随包附带 Node.js，无需另行安装。保留服务窗口，Ctrl+C 停止服务。\r\n` +
  `3. 在 SPlayer-Next 的插件管理中本地导入 plugins\\splayer-live-lyrics.js（${pluginVersion}），启用 network 和 control 权限。\r\n` +
  `   歌词需要 API 4 或以上；B 站点歌及原生队列需要 API 5。更新导入相同插件 ID 即可。\r\n` +
  `4. 歌词设置：http://127.0.0.1:19633/\r\n` +
  `5. OBS 浏览器源：http://127.0.0.1:19633/obs，建议先用 1200 × 180。声音由 SPlayer 和 OBS 单独处理。\r\n\r\n` +
  `观众点歌：在设置页扫码登录 B 站，输入直播间号，用账号模式连接，选择音源，启用点歌处理并应用。\r\n` +
  `观众发送「点歌 晴天」，进入后端队列；轮到时搜索第一项并安排为 SPlayer 下一首。当前歌曲继续播放。\r\n` +
  `每次只预放一首，确认该曲开始播放后再安排后续点歌，剩余顺序保存在后端。\r\n` +
  `SPlayer 会跳过列表已有歌曲，接口无法将其移动到下一首；此类请求明确显示“已在播放列表”并继续。\r\n` +
  `设置页显示真实队列与点歌处理记录。排序、移除、播放及切歌请在 SPlayer 操作。\r\n` +
  `随机或单曲循环会影响点歌顺序；暂停或空闲时添加歌曲不会自动开始播放。\r\n` +
  `入队结果不确定时会暂停后续处理，核对 SPlayer 播放列表后再点击继续；不会自动重复入队。\r\n\r\n` +
  `待播歌曲被跳过或移除时，可核对后解除待播等待；此操作不删除 SPlayer 中的歌曲。\r\n\r\n` +
  `数据：B 站凭据和点歌待处理记录仅存内存，重启需重新登录、连接及启用点歌。\r\n` +
  `自定义 CSS 和布局保存在本文件夹的 *.local 文件中。升级前停止旧服务，手动复制这些文件可保留外观设置。\r\n` +
  `如果已有歌词服务运行，启动器会打开现有服务，不会关闭或替换它。切换到新版请先停止旧服务。\r\n\r\n` +
  `范围：首版为本机运行的预览版本，包含透明歌词、歌曲信息、动画、翻译音译、自定义样式与布局、B 站点歌及原生队列。\r\n` +
  `AMLL 等额外渲染器尚未交付。自动化和浏览器测试通过；真实房间到原生入队仍需人工验收。\r\n` +
  `组件许可见 THIRD_PARTY_NOTICES.md、licenses 和 runtime/LICENSE。\r\n`, "utf8");

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files.sort();
}
const hashes = [];
for (const path of await filesIn(output)) {
  hashes.push({ path: relative(output, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
}
await writeFile(join(output, "manifest.json"), JSON.stringify({ ...metadata, files: hashes }, null, 2) + "\n");
const compression = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Compress-Archive -LiteralPath $env:SPLAYER_RELEASE_FOLDER -DestinationPath $env:SPLAYER_RELEASE_ZIP -CompressionLevel Optimal"], {
  windowsHide: true, stdio: "inherit", env: { ...process.env, SPLAYER_RELEASE_FOLDER: output, SPLAYER_RELEASE_ZIP: archive },
});
if (compression.error) throw compression.error;
if (compression.status !== 0) throw new Error("压缩失败；已保留完整构建目录供检查");
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(archive + ".sha256", `${digest}  ${basename(archive)}\n`);
console.log(`首版已构建：${resolve(archive)}`);
console.log(`解压目录：${output}`);
console.log(`SHA256：${digest}`);
