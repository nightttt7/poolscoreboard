# poolscoreboard

一个手机优先的双人台球计分板网站，运行在 Hono + Cloudflare Workers + D1 上。

## 人必须做的事

先在两个地方配置同一组凭据：

1. GitHub Actions secrets：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `ADMIN_PASSWORD`
2. 本地机器的永久环境变量：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `ADMIN_PASSWORD`

> 本地开发和 GitHub Actions 共用同一组凭据；其中 `ADMIN_PASSWORD` 会同步到保留的 `admin` 账号，并作为页面上的 Admin 登录入口密码。

## 当前产品行为

- 玩家只需要填写名字，不需要账号密码登录
- 同时保留一个固定 `admin` 账号，并提供单独的 Admin 登录入口
- 身份通过数据库保存的 Cookie 会话校验
- 一个玩家同一时间只能在一场比赛里
- 创建比赛时会优先生成随机两位数编号；两位数用满后会自动扩展到更多位
- 每场比赛最多两位玩家，任意一位退出后可由新玩家补位
- 双方都可以修改目标局数、每局胜负和双方犯规次数
- 总比分只读，达到目标局数后会自动宣布胜利
- 两位玩家都退出，或 6 小时无人操作后，比赛会自动删除

## 本地启动

```bash
npm install
npm run db:reset:local
npm run dev
```

打开本地 Worker 页面后：

1. 输入名字
2. 创建新比赛，或输入比赛编号加入比赛
3. 直接在手机页面上操作计分板

## 测试

```bash
npm test
npm run typecheck
```

## 部署

用户把改动推送到 `main` 后，现有 GitHub Actions 会继续执行：安装依赖、跑 typecheck / test、执行远程 migration、同步 `ADMIN_PASSWORD`、再部署 Worker。
