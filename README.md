# Color Toy

Lightweight web app for exploring and editing colors with a GPU-accelerated preview, tone-curve tools, and PWA install support.

This repository contains the full source for the Color Toy web app (development build, shaders, and PWA assets).

主要功能 / Key Features
- GPU-accelerated color preview with shader-based color processing
- Tone curve editor, picker tools, and preset management
- Adaptive rendering for high-DPI / mobile devices
- PWA support (manifest + service worker) for offline and installable experience

快速开始 / Quick Start
Prerequisites: Node.js 16+ and npm

1. Install dependencies

   npm install

2. 开发服务器 / Start dev server

   npm run dev

3. 本地构建 / Build for production

   npm run build

质量检查 / Quality Gates
- 类型检查: `npm run typecheck`
- Lint: `npm run lint`
- 测试: `npm run test:run`
- 完整检查（类型 + lint + 测试 + 构建）: `npm run check`

PWA 与 部署 / PWA & Deployment
- `manifest.json` 位于站点根，使应用可被识别为安装目标。
- `sw.js` 在站点根注册以提供离线缓存策略。
- 在部署到 Cloudflare Pages 或其他静态主机时，确保 `manifest.json` 与 `sw.js` 可从根路径访问并且响应头（Content-Type、Service-Worker-Allowed）正确。

部署到 Cloudflare Pages（简要）
1. 将仓库推送到与你的 Pages 项目关联的 Git 分支。
2. 确保构建命令为 `npm run build`，输出目录为 `dist`（或项目配置中指定的目录）。

贡献 / Contributing
- 感谢贡献！请基于 `main` 分支创建功能分支并提交 PR。遵循现有代码风格并运行 `npm run check` 以确保 CI 通过。

许可证 / License
- MIT（仓库根如有 LICENSE 文件则以其为准）

作者 / Maintainers
- See repository collaborators and commit history.

如果你需要我替换 README 的其他内容（例如英文/中文的更详细说明、示例截图或徽章），告诉我需要的细节，我会继续完善。
