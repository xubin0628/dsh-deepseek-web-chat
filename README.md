# 网页版 DeepSeek · dsh-deepseek-web-chat

在 DeepSeek Harness 左侧栏加一个「网页版 DeepSeek」入口，点开就在中间面板整页打开免费的
[chat.deepseek.com](https://chat.deepseek.com/) 网页版——用你自己的网页版登录态、免费额度和
网页端会话历史，不消耗 Harness 的 API 额度。

## 为什么需要本机反代

官网响应头带 `content-security-policy: frame-ancestors 'none'`，浏览器会拒绝任何页面用 iframe
嵌入它；它的接口又是绝对路径 `/api/v0/...`，就算绕过框架限制，请求也会打到 Harness 自己的
地址上。所以插件在本机起一个**只绑回环**的反向代理，让整站在代理自己的 origin 上跑起来：

| 卡点 | 处理 |
| --- | --- |
| `frame-ancestors 'none'` | 文档由代理重发，去掉 CSP / X-Frame-Options / HSTS |
| 静态资源在 `fe-static.deepseek.com`，CORS 只放行 deepseek 域 | HTML、JS、CSS 里的 CDN 地址改写成同源 `/_cdn/...`，顺带去掉 `integrity` / `crossorigin` |
| 主包把「IP 主机」判成 dev 环境 | 改写该分支为 production，避免给生产接口加调试头 |
| 接口 `/api/v0/*` | 同源命中代理，原样流式转发（含 SSE、上传、PoW 校验头） |
| Cookie | 站点 Cookie 收在 Host 进程内的罐子里，不回传浏览器；Harness 自己的登录 Cookie 绝不发往上游 |
| 站点隔离 | 站点用 `localhost`、界面在 `127.0.0.1`：不同站点，localStorage 互不相干 |
| 响应头污染 | 白名单转发，绝不透传 HSTS、alt-svc、Access-Control-* |

代理只监听 `127.0.0.1` 与 `[::1]`，不对外网开放，不记录请求，数据只在这台机器上流转。

## 使用

1. 点左侧栏的 **网页版 DeepSeek** 图标。
2. 用**手机号 + 验证码**登录一次（或密码登录）。
3. 之后不用再登录：重启 Harness 也保持登录。顶栏有 **重新加载**、**在新标签页打开**、**导入登录态**；
   右下角有 **清除已保存的登录态**。

### 登录为什么不会再掉

网页版的登录靠 HttpOnly 会话 Cookie（`ds_session_id` 等）。插件把它做成了持久化：

- 代理的 Cookie 罐一开始只存内存，Harness 一重启就清空 —— 那就是之前「总是掉线」的根因；
- 现在 Cookie 每次变化都合并写入 DSH 的凭据存储（`deepseek-web-chat/site-session`），
  启动时再原样装回罐子；
- `localStorage.userToken` 也一并持久化，首屏注入，作为会话过期后的兜底；
- 「是否真的登录着」不靠猜：面板向 `/api/v0/users/current` 问一次，`code: 0` 才算登录。

清理入口是 DELETE `/deepseek-web/api/session`，面板上的「清除已保存的登录态」就是它。

### 关于「自动用 DSH 账号登录」

做不到，原因是账号体系不同，不是没实现：

| | DSH 账号 | 网页版 |
| --- | --- | --- |
| 域名 | `platform.deepseek.com` | `chat.deepseek.com` |
| 认证头 | `x-dsh-auth-token` | `Authorization: Bearer` |
| 用途 | API Key、余额、充值 | 网页聊天、免费额度 |

实测：把 DSH 存着的 platform token 带到 `chat.deepseek.com/api/v0/users/current`，返回
`40003 Authorization Failed`。网页版没有对第三方站点开放 OAuth，所以无法用 DSH 登录态换取网页版登录。

### 关于微信扫码（已隐藏）

官网的登录页自带微信扫码列。它在本插件里**必然不可用**，原因是硬编码的域名兜底：

- 微信开放平台只把 `https://chat.deepseek.com` 登记为该 appid 的回调域名；
- 官网主包在 `http://localhost` 下会把 `redirect_uri` 兜底成 `chat-dev.deepseek.com`（测试域名）；
- 微信不认这个域名，扫码框因此显示「redirect_uri 参数」。

实测 5 个候选 redirect_uri，只有 `https://chat.deepseek.com` 能拿到二维码，其余全部返回错误页。
让它在 localhost 下可用需要改 hosts、装一个能签发 `chat.deepseek.com` 的本机 CA、并占用 443，
都属于系统级改动。**插件直接把这一列隐藏掉**（注入一条 `.ds-sign-in-form__main-wechat{display:none}`），
只保留手机号与密码登录，页面自动居中、不留空白。手机号登录对「不掉线」也更有利，因为它走 Cookie。

### 被验证码卡住时

站点的图形验证码按域名签发令牌，代理域名下可能过不去。兜底路径：

1. 浏览器打开 chat.deepseek.com（保持已登录）→ F12 → Console → `copy(localStorage.userToken)`
2. 回到面板 → 顶栏「导入登录态」 → 粘贴 → 写入并重载

粘贴的值会先由 Host 向上游 `/api/v0/users/current` 校验，无效会当场报错（422），不会被当作成功。
校验通过后存进 Harness 的凭据存储（`deepseek-web-chat/site-session`），重启后自动恢复。
往页面注入时只灌一次，注入后立刻从内存清掉。

## 配置

`cordis.patch.yml` 里的 `port` 是首选端口（默认 45177，被占用时自动向上顺延 20 个）。
端口固定有意义：官网登录态存在这个 origin 的 localStorage 里，换端口等于换设备。

## 端点

方法 | 路径 | 用途
--- | --- | ---
GET | `/deepseek-web/api/endpoint` | 回报代理地址（走 Harness 自己的 webServer，同源）
GET | `/deepseek-web/api/session` | 登录态现状（是否已保存）
POST | `/deepseek-web/api/session` | 导入登录态（先校验，再存进凭据存储）
DELETE | `/deepseek-web/api/session` | 清除已保存的登录态

代理自身另有 `GET /_dsw/health`（本机诊断）。

## 已知边界

- 只绑本机回环，不对外网开放。
- DSH 账号与网页版是两套账号，token 不通用：不能用 DSH 登录态自动登录网页版。
- 微信扫码已隐藏（见上），请用手机号或密码登录。
- 语音朗读走 `wss://.../api/v0/chat/tts/`，未代理；其它功能不依赖它。
- 图形验证码（shumei / hcaptcha / Turnstile）按域名发放令牌，代理域下可能被拒，见上面的导入登录态。
- 官网改版导致改写失效时，面板会停在白屏，顶栏「在新标签页打开」仍能用。

## 目录

```
.
├── index.js            # Host：起/停代理、登录态读写端点
├── proxy.js            # 回环反代本体（HTML/JS/CSS 改写、API 透传、token 注入与校验）
├── cookies.js          # 站点 Cookie 罐（变化时落盘，重启后装回）
├── session-store.js    # 登录态持久化（Cookie + token 存进 DSH credentials）
├── client.js           # 浏览器：侧栏图标 + 整页面板 + 顶栏
├── cordis.patch.yml    # bundle 行（port）
├── locale/{zh,en}.json # 插件管理器里的标题与描述
├── docs/               # 详情页图与本地化说明
└── icon.svg
```
