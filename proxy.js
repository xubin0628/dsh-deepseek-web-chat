/**
 * 本机回环反代：把 chat.deepseek.com 以「独立站点」的形式搬到
 * http://localhost:<port>/ ，供页面里的 iframe 加载。
 *
 * 为什么需要它：官网响应头带 `content-security-policy: frame-ancestors 'none'`，
 * 任何页面都无法直接 iframe 嵌入；而且站点接口用的是绝对路径 `/api/v0/...`，
 * 直接嵌会被打到 Harness 自己的域名上。所以这里起一个只绑回环地址的转发器，
 * 让整站在它自己的 origin 上跑起来：
 *
 * - HTML：去掉 CSP / X-Frame-Options / HSTS，改写 fe-static CDN 到同源 `/_cdn/`，
 *   去掉 integrity / crossorigin（改写过的字节不能带 SRI）；
 * - JS / CSS：把 `https://fe-static.deepseek.com/` 改写成 `/_cdn/`，并把主包里
 *   「回环主机 = dev 环境」的分支改成 production（dev 会给生产接口加调试头）；
 * - 接口：`/api/v0/*` 原样流式转发（含 SSE、上传、PoW 校验头）；
 * - Cookie：站点 Cookie 留在这份进程内的罐子里，不回传浏览器，也绝不把 Harness
 *   自己的 cookie 发给上游；站点用 `localhost`，界面在 `127.0.0.1`，两者是不同的
 *   站点，localStorage 天然隔离，登录态不会互相串味。
 *
 * 只监听回环地址；不对外网开放，不落盘、不记录请求。
 */
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { CookieJar } from './cookies.js'

const CHAT_ORIGIN = 'https://chat.deepseek.com'
const CDN_ORIGIN = 'https://fe-static.deepseek.com'
const CDN_PREFIX = '/_cdn'

/** 逐跳头：既不能从请求带过去，也不能从响应带回来。 */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** 不透传的响应头。 */
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'alt-svc',
  'public-key-pins', 'public-key-pins-report-only', 'expect-ct', 'nel', 'report-to',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers',
  'set-cookie',
])

const DECODERS = {
  gzip: (buffer) => zlib.gunzipSync(buffer),
  'x-gzip': (buffer) => zlib.gunzipSync(buffer),
  deflate: (buffer) => zlib.inflateSync(buffer),
  br: (buffer) => zlib.brotliDecompressSync(buffer),
}

/**
 * 主包里的环境判定分支。用回环主机访问时会被判成 dev 环境，
 * dev 会给生产接口追加空的 x-debug-* 头，这里改成 production。
 */
const ENV_PATCHES = [
  ['if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"dev";', 'if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"production";'],
  ['case"localhost":return"dev";', 'case"localhost":return"production";'],
]

/** 站点 Cookie 罐（实现见 cookies.js，只存这份进程内存）。 */
export { CookieJar } from './cookies.js'

/** 从浏览器带来的 Cookie 里挑出站点自己的那些，丢掉 Harness 的登录 Cookie。 */
function browserCookies(headerValue, jarNames) {
  if (typeof headerValue !== 'string') return []
  const kept = []
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at <= 0) continue
    const name = segment.slice(0, at).trim()
    if (name.startsWith('dsh-auth')) continue
    if (jarNames.has(name)) continue
    kept.push(segment.trim())
  }
  return kept
}

/** CDN 绝对地址 -> 同源 `/_cdn/...`。 */
function rewriteCdn(text) {
  return text
    .split(`${CDN_ORIGIN}/chat/`).join(`${CDN_PREFIX}/chat/`)
    .split(`${CDN_ORIGIN}/`).join(`${CDN_PREFIX}/`)
}

/** 上游的重定向目标改回代理自身。 */
function rewriteLocation(value) {
  if (typeof value !== 'string') return value
  for (const origin of [CHAT_ORIGIN, CDN_ORIGIN]) {
    if (value === origin) return '/'
    if (value.startsWith(`${origin}/`)) return value.slice(origin.length)
  }
  if (value.startsWith('//chat.deepseek.com/')) return value.slice('//chat.deepseek.com'.length)
  return value
}

/**
 * 登录页的本地样式补丁。
 *
 * 为什么要藏微信：微信开放平台把这个 appid 的回调域名只登记为
 * `https://chat.deepseek.com`，而官网在 `http://localhost` 下会把 redirect_uri
 * 兜底成 `chat-dev.deepseek.com`（测试域名），微信不认，扫码框必然显示
 * 「redirect_uri 参数」。让它可用需要改 hosts、装本机 CA、占 443，
 * 属于系统级改动；按产品决定直接隐藏这一列，只保留手机号/密码登录。
 *
 * 只加样式、不改站点逻辑：`.ds-sign-in-form__main-wechat` 是整列容器，
 * 隐藏它之后表单自己居中，不会留下空白列。
 */
const LOGIN_STYLE = `<style id="dswc-hide-wechat">
.ds-sign-in-form__main-wechat{display:none!important}
.ds-sign-in-with-wechat-block{display:none!important}
</style>`

function rewriteText(text, kind, tokenScript) {
  let out = rewriteCdn(text)
  if (kind === 'js') {
    for (const [from, to] of ENV_PATCHES) out = out.split(from).join(to)
  }
  if (kind === 'html') {
    // 改写过字节的脚本不能再带 SRI，否则浏览器直接拒绝执行。
    out = out.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin(?:\s*=\s*"[^"]*")?/gi, '')
    out = out.replace(/<\/head>/i, `${LOGIN_STYLE}${tokenScript || ''}</head>`)
  }
  return out
}

/** 把导入的登录态写进站点 origin 的 localStorage，赶在应用启动之前。 */
function buildTokenScript(token) {
  if (!token) return ''
  const value = JSON.stringify(String(token)).replaceAll('<', '\\u003c')
  return `<script>try{localStorage.setItem('userToken',${value})}catch(e){}</script>`
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const text = `${message}\n`
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 转发一次请求；文本类响应先缓冲再改写，其余（SSE、二进制、上传回包）直接流式转发。 */
function proxy(req, res, target, options) {
  const url = new URL(target.origin + target.path)
  const transport = url.protocol === 'https:' ? https : http
  const jar = options.jar

  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'accept-encoding' || name === 'origin' || name === 'referer' || name === 'cookie') continue
    // 上游的 304 会让改写后的正文对不上，直接要求完整响应。
    if (name === 'if-none-match' || name === 'if-modified-since' || name === 'range') continue
    headers[name] = value
  }

  const cookies = [...browserCookies(req.headers.cookie, jar.names())]
  const jarHeader = jar.header()
  if (jarHeader) cookies.push(jarHeader)
  if (cookies.length > 0) headers.cookie = cookies.join('; ')

  headers.host = url.host
  headers.origin = target.origin
  headers.referer = `${CHAT_ORIGIN}/`
  headers['accept-encoding'] = 'identity'

  const upstream = transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    jar.absorb(upstreamRes.headers['set-cookie'])
    const out = {}
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (DROP_RESPONSE.has(key.toLowerCase())) continue
      out[key] = value
    }
    if (out.location) out.location = rewriteLocation(out.location)

    const status = upstreamRes.statusCode || 502
    const type = String(upstreamRes.headers['content-type'] || '').toLowerCase()
    const encoding = upstreamRes.headers['content-encoding']
    const kind = type.includes('text/html')
      ? 'html'
      : /javascript|ecmascript/.test(type)
        ? 'js'
        : type.includes('text/css')
          ? 'css'
          : null
    const streaming = kind === null || type.startsWith('text/event-stream')
      || (typeof encoding === 'string' && encoding !== '' && encoding !== 'identity' && DECODERS[encoding] === undefined)

    if (streaming) {
      res.writeHead(status, out)
      upstreamRes.pipe(res)
      return
    }

    const chunks = []
    upstreamRes.on('data', (chunk) => chunks.push(chunk))
    upstreamRes.on('error', (error) => fail(res, 502, `upstream read failed: ${error.message}`))
    upstreamRes.on('end', () => {
      let body = Buffer.concat(chunks)
      if (typeof encoding === 'string' && DECODERS[encoding]) body = DECODERS[encoding](body)
      // 导入的登录态只为「下一次文档加载」注入一次，注入后立刻清掉，不在内存里长期留凭据。
      const token = kind === 'html' ? options.takeToken() : null
      const text = rewriteText(body.toString('utf8'), kind, buildTokenScript(token))
      delete out['content-encoding']
      out['content-type'] = kind === 'html'
        ? 'text/html; charset=utf-8'
        : kind === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
      out['content-length'] = Buffer.byteLength(text)
      res.writeHead(status, out)
      res.end(req.method === 'HEAD' ? undefined : text)
    })
  })

  upstream.on('error', (error) => fail(res, 502, `upstream unavailable: ${error.message}`))
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

/** 裸 http server（不含监听），地址可复用到 IPv4 与 IPv6。 */
function createHandler(state) {
  return (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      fail(res, 400, 'bad request')
      return
    }
    try {
      if (url.pathname === '/_dsw/health') {
        // 只报「有没有待注入的登录态」，不回显 token 本身。
        sendJson(res, 200, { ok: true, origin: CHAT_ORIGIN, port: state.port, pending: state.pending !== null })
        return
      }
      if (url.pathname === CDN_PREFIX || url.pathname.startsWith(`${CDN_PREFIX}/`)) {
        const rest = url.pathname.slice(CDN_PREFIX.length) || '/'
        proxy(req, res, { origin: CDN_ORIGIN, path: rest + url.search }, state)
        return
      }
      proxy(req, res, { origin: CHAT_ORIGIN, path: url.pathname + url.search }, state)
    } catch (error) {
      fail(res, 500, `proxy failure: ${error && error.message ? error.message : String(error)}`)
    }
  }
}

/**
 * 用上游接口校验一个网页版 token：当前用户接口在 token 有效时返回用户信息，
 * 无效时回 40003 / 40002。避免把一串无关字符当作导入成功。
 * @param {string} token
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export function verifyToken(token) {
  return new Promise((resolve) => {
    if (typeof token !== 'string' || token.trim() === '') {
      resolve({ valid: false, reason: 'empty token' })
      return
    }
    const req = https.request({
      hostname: 'chat.deepseek.com',
      path: '/api/v0/users/current',
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'application/json',
        authorization: `Bearer ${token.trim()}`,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(body && body.code === 0
            ? { valid: true }
            : { valid: false, reason: `upstream code ${body && body.code}` })
        } catch {
          resolve({ valid: false, reason: 'unreadable response' })
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, reason: 'timeout' }) })
    req.on('error', (error) => resolve({ valid: false, reason: error.message }))
    req.end()
  })
}

/**
 * 用罐子里的 Cookie 向上游确认登录是否仍然有效。
 *
 * 光看 Cookie 名不行：`ds_session_id` 在未登录时也会下发。真正可靠的判据是
 * 让上游接口回答——`/api/v0/users/current` 对已登录会话返回 `code: 0`，
 * 未登录或过期返回 `40002 / 40003`。
 *
 * @param {CookieJar} jar
 * @returns {Promise<boolean>}
 */
export function checkLogin(jar) {
  return new Promise((resolve) => {
    const cookie = jar.header()
    if (cookie === '') {
      resolve(false)
      return
    }
    const req = https.request({
      hostname: 'chat.deepseek.com',
      path: '/api/v0/users/current',
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'application/json',
        cookie: `${cookie}; smidV2=`,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(Boolean(body && body.code === 0))
        } catch {
          resolve(false)
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 起一个只监听回环地址的转发器。站点用 `localhost`，与界面的 `127.0.0.1` 是两个站点。
 * @param {{
 *   port?: number,
 *   log?: (message: string) => void,
 *   token?: string | null,
 *   cookies?: Record<string, { value: string, deadline: number }>,
 *   onCookies?: (snapshot: Record<string, { value: string, deadline: number }>) => void,
 * }} options
 *   `cookies` 是上次落盘的罐子快照；`onCookies` 在 Cookie 变化时被调用（由调用方负责落盘）。
 */
export function createProxyServer(options = {}) {
  const preferredPort = Number(options.port) > 0 ? Math.trunc(Number(options.port)) : 45177
  const log = options.log || (() => {})
  const jar = new CookieJar({ save: options.onCookies })
  const state = {
    port: 0,
    pending: options.token || null,
    jar,
    // 只有文档加载会取走待注入的登录态，取一次就清空。
    takeToken() {
      const next = state.pending
      state.pending = null
      return next
    },
  }
  const handler = createHandler(state)
  const servers = []
  let port = 0

  function spawn(address) {
    const server = http.createServer(handler)
    server.on('upgrade', (req, socket) => {
      // 语音朗读走 wss，这里没有转发；其余功能不依赖它。
      socket.write('HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      socket.destroy()
    })
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
    })
    return new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error) }
      const onListening = () => { server.removeListener('error', onError); resolve(server) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(address.port, address.host)
    })
  }

  async function closeAll() {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))))
    servers.length = 0
  }

  return {
    /** 端口被占用时向上顺延，最多试 20 个；IPv6 不可用时只留 IPv4。 */
    async start() {
      if (port !== 0) return port
      let lastError = null
      for (let offset = 0; offset < 20; offset += 1) {
        const candidate = preferredPort + offset
        const bound = []
        try {
          bound.push(await spawn({ port: candidate, host: '127.0.0.1' }))
          try {
            bound.push(await spawn({ port: candidate, host: '::1' }))
          } catch {
            // 系统没开 IPv6：只留 IPv4 也能用。
          }
        } catch (error) {
          await Promise.all(bound.map((server) => new Promise((resolve) => server.close(() => resolve()))))
          lastError = error
          if (error && error.code === 'EADDRINUSE') continue
          throw error
        }
        servers.push(...bound)
        port = candidate
        const shape = bound.length > 1 ? '127.0.0.1 + [::1]' : '127.0.0.1'
        if (offset > 0) log(`port ${preferredPort} busy, using ${port}`)
        log(`listening on ${shape}:${port}`)
        state.port = port
        return port
      }
      throw lastError || new Error('no free loopback port')
    },
    get port() { return port },
    get url() { return port === 0 ? '' : `http://localhost:${port}/` },
    get origin() { return CHAT_ORIGIN },
    /** 记下一次待注入的登录态；下一次文档加载取走后就没了。 */
    setToken(next) {
      state.pending = typeof next === 'string' && next.trim() !== '' ? next.trim() : null
      return state.pending !== null
    },
    hasPendingToken() { return state.pending !== null },
    /** 把已落盘的会话 Cookie 装回罐子里（重启后恢复登录用）。 */
    restoreCookies(snapshot) { return jar.restore(snapshot) },
    /** 罐子里是否有仍然有效的会话 Cookie。 */
    hasSession() { return jar.hasSession() },
    /** 用罐子里的 Cookie 向上游确认登录是否仍然有效。 */
    checkLogin() { return checkLogin(jar) },
    /** 当前罐子快照（落盘或诊断用）。 */
    cookieSnapshot() { return jar.snapshot() },
    /** 清空罐子（用户主动退出）。 */
    clearCookies() { jar.clear() },
    async close() {
      if (port === 0) return
      await closeAll()
      port = 0
      state.port = 0
      state.pending = null
    },
  }
}
