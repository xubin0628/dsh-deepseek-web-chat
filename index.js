/**
 * dsh-deepseek-web-chat · Host 半边
 *
 * 在侧栏「网页版 DeepSeek」入口背后，起一个只绑本机回环的反向代理（见 proxy.js），
 * 让 chat.deepseek.com 能作为独立站点嵌进 Harness 的面板里。
 *
 * 登录态的长久性由两处合力保证：
 * 1. 站点会话 Cookie 由代理的 Cookie 罐持有，变化时写进 DSH 的凭据存储，重启后装回去；
 * 2. localStorage.userToken 同样持久化，首屏注入，作为会话过期后的兜底。
 *
 * 端点：
 *   GET    /deepseek-web/api/endpoint  取代理地址（走 Harness 自己的 webServer，同源）
 *   GET    /deepseek-web/api/session   登录态现状
 *   POST   /deepseek-web/api/session   导入登录态（先让上游校验，再持久化）
 *   DELETE /deepseek-web/api/session   清除登录态
 */
import { createProxyServer, verifyToken } from './proxy.js'
import { createSessionStore } from './session-store.js'

export const name = 'deepseek-web-chat'
export const inject = ['webServer']

const BASE = '/deepseek-web'
const DEFAULT_PORT = 45177

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 只接受同源页面发来的 JSON。 */
function readJson(req, max = 8 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') throw Object.assign(new Error('method not allowed'), { status: 405 })
    const origin = req.headers.origin
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) {
      throw Object.assign(new Error('cross-origin request refused'), { status: 403 })
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(Object.assign(error, { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, config = {}) {
  const log = (message) => ctx.logger?.info?.(message)
  const store = createSessionStore(ctx)

  // Cookie 每次变化都要落盘，但不必每条请求都写：合并到一次微任务里。
  let cookieWriteTimer = null
  let cookieWritePending = null
  const flushCookies = () => {
    cookieWriteTimer = null
    const snapshot = cookieWritePending
    cookieWritePending = null
    if (snapshot === null) return
    void store.writeCookies(snapshot).catch(() => {})
  }

  const proxy = createProxyServer({
    port: Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT,
    log,
    onCookies(snapshot) {
      cookieWritePending = snapshot
      if (cookieWriteTimer === null) cookieWriteTimer = setTimeout(flushCookies, 250)
    },
  })

  // 启动时把上次的登录态装回去：会话 Cookie 直接灌进罐子，token 进待注入队列。
  const restored = store.read().then((saved) => {
    if (saved.cookies && Object.keys(saved.cookies).length > 0) {
      proxy.restoreCookies(saved.cookies)
      log(`deepseek-web-chat: restored ${Object.keys(saved.cookies).length} site cookie(s)`)
    }
    if (saved.token !== null) {
      proxy.setToken(saved.token)
      log('deepseek-web-chat: restored saved web sign-in')
    }
    return saved
  }, () => ({ token: null, cookies: {} }))

  // 监听是异步的；地址接口在端口还没绑上时回 503，页面那边会重试。
  const started = proxy.start().then(
    (port) => {
      log(`deepseek-web-chat: reverse proxy listening on http://localhost:${port}`)
      return port
    },
    (error) => {
      ctx.logger?.error?.(`deepseek-web-chat: proxy failed to start: ${error?.message ?? error}`)
      return 0
    },
  )

  ctx.effect(() => {
    const route = ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const rest = url.pathname.slice(BASE.length) || '/'

        if (rest === '/api/endpoint') {
          const port = await started
          if (port === 0) {
            sendJson(res, 503, { ok: false, error: 'proxy is not listening' })
            return
          }
          sendJson(res, 200, { ok: true, url: proxy.url, port, site: proxy.origin })
          return
        }

        if (rest === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
          await started
          await restored
          // 每次都重新读存储：导入 / 清除之后状态要立刻反映出来。
          const saved = await store.read()
          // 光有 Cookie 不代表还登录着，让上游确认一次；失败不当作掉线，只是「未知」。
          const signedIn = proxy.hasSession() ? await proxy.checkLogin() : false
          sendJson(res, 200, {
            ok: true,
            saved: saved.token !== null || Object.keys(saved.cookies).length > 0,
            signedIn,
          })
          return
        }

        if (rest === '/api/session' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const token = typeof body.token === 'string' ? body.token.trim() : ''
            if (token === '') {
              sendJson(res, 400, { ok: false, error: 'token must be a non-empty string' })
              return
            }
            // 先让上游确认这串 token 真的能登录，再存；否则用户会以为导入成功了。
            const verdict = await verifyToken(token)
            if (!verdict.valid) {
              sendJson(res, 422, { ok: false, error: 'token rejected by DeepSeek', reason: verdict.reason })
              return
            }
            await started
            proxy.setToken(token)
            const saved = await store.writeToken(token)
            sendJson(res, 200, { ok: true, saved })
          } catch (error) {
            sendJson(res, error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        if (rest === '/api/session' && req.method === 'DELETE') {
          proxy.clearCookies()
          await store.clear()
          sendJson(res, 200, { ok: true, saved: false, signedIn: false })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    })

    return () => {
      route()
      if (cookieWriteTimer !== null) {
        clearTimeout(cookieWriteTimer)
        flushCookies()
      }
      void proxy.close()
    }
  })
}
