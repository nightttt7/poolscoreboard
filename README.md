# Hono GitHub Cloudflare Template

一个适合快速原型的 Hono + Cloudflare Workers + D1 模板。

## 人必须做的事

这些事情 AI 不能替你自动完成：

在两个地方配置同一组凭据：

1. GitHub 新仓库的 Actions secrets：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `ADMIN_PASSWORD`
2. 本地机器的永久环境变量：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `ADMIN_PASSWORD`

这个模板故意让本地和 GitHub 使用同一组变量名，避免开发环境和部署环境各走一套配置。

## 模板默认行为

- 仓库名 / 目录名 / Worker 名统一视作 `[项目名]`
- D1 名固定为 `[项目名]-prod`
- deploy 地址是 `https://[项目名].<你的-workers.dev-子域>.workers.dev`
- `npm run sync:project` 会把命名同步到 `package.json`、`wrangler.jsonc`、`src/project.ts`

## 安全说明

- 任何人都可以打开 dev 页面
- 只有登录后才能读取和修改 todo 数据
- 初始账号固定为 `admin`
- 初始密码在部署环境来自 Worker secret `ADMIN_PASSWORD`，在本地开发时来自本地环境变量 `ADMIN_PASSWORD`
- 应用本身仍保留 `admin` 用户首次成功登录时按当时 `ADMIN_PASSWORD` 懒创建的能力
- GitHub Actions 每次 deploy 都会把远程 Worker secret 和远程 D1 里的 `admin` 密码同步成最新的 `ADMIN_PASSWORD`
- 本地如果你修改了 `ADMIN_PASSWORD`，需要执行 `npm run db:reset:local` 或手动更新该用户密码
- 登录系统是数据库驱动的，用户和会话都存进 D1，方便后续扩展

## 快速开始

### 本地

先在系统里把 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_PASSWORD` 配置成永久环境变量，再执行：

```bash
npm install
npm run db:reset:local
npm run dev
```

`db:reset:local` 会从零重建本地 Wrangler D1 数据库，再应用 migrations，适合本地重新开始或让 AI 直接执行。

### 测试

```bash
npm test
npm run typecheck
```

### 部署

push 或 merge 到 `main` 后，deploy workflow 会：

1. 先检查 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_PASSWORD` 这 3 个 Actions secrets 是否齐全；缺任何一个都会直接停止并报出缺少的 secret 名
2. 安装依赖
3. 同步项目名
4. 跑 typecheck 和测试
5. 确保远程 D1 `[项目名]-prod` 存在
6. 上传 Worker secret `ADMIN_PASSWORD`
7. 执行远程 migration
8. 把远程 D1 里的 `admin` 密码同步成最新的 `ADMIN_PASSWORD`
9. 部署 Worker

## 最小页面

模板自带一个最小可运行页面：

- 使用 D1 `todos` 表
- 有基本 HTML + CSS + JS
- 支持登录
- 支持创建 todo
- 支持切换完成状态

## 常用命令

```bash
npm run sync:project
npm run db:reset:local
npm run db:migrate:remote
npm run db:ensure:remote
npm run dev
npm test
```
