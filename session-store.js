/**
 * 网页版登录态的持久化。
 *
 * 两样东西要记住，缺一不可：
 * 1. `cookies` —— 网页版的 HttpOnly 会话 Cookie。这是「登录不掉的」真正载体；
 * 2. `token`   —— 浏览器的 localStorage.userToken，用于首屏注入和登录失效后的兜底。
 *
 * 存储用 DSH 自己的 credentials 服务（`ctx.credentials`）：
 * - 它是 profile 层被授权的密钥存放处，跨重启有效；
 * - `modifyRecord` 是串行读-改-写，不会写坏别人的记录；
 * - 插件卸载后记录仍可列出，用户能发现并清理孤儿凭据。
 *
 * 这里存的是 chat.deepseek.com 的网页版凭据，和 DSH 账号（platform.deepseek.com）
 * 不是同一套，不能互相顶替。
 */
const RECORD_KEY = 'deepseek-web-chat/site-session'
const RECORD_VERSION = 2

/** 校验形状：必须是 DSH credentials 的 grant 记录，且带我们的版本号。 */
function usable(record) {
  if (record === undefined || record === null) return false
  if (record.kind !== 'grant') return false
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return false
  if (payload.version !== RECORD_VERSION) return false
  const hasToken = typeof payload.token === 'string' && payload.token.trim() !== ''
  const hasCookies = typeof payload.cookies === 'object' && payload.cookies !== null
  return hasToken || hasCookies
}

/** 只保留 cookie 名 -> { value, deadline } 这种形状，防止写进脏数据。 */
function sanitizeCookies(raw) {
  if (typeof raw !== 'object' || raw === null) return {}
  const out = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof name !== 'string' || name === '') continue
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.value !== 'string') continue
    const deadline = typeof entry.deadline === 'number' ? entry.deadline : Number.POSITIVE_INFINITY
    out[name] = { value: entry.value, deadline }
  }
  return out
}

/**
 * 建一个登录态存储门面。
 * @param {{ get: (name: string) => any }} ctx Cordis 上下文（读取可选的 credentials 服务）。
 */
export function createSessionStore(ctx) {
  let cached = null

  function service() {
    const found = ctx.get('credentials')
    return found === undefined ? null : found
  }

  async function load() {
    if (cached !== null) return cached
    const store = service()
    if (store === null) return { token: null, cookies: {} }
    try {
      const record = await store.readRecord(RECORD_KEY)
      if (!usable(record)) return { token: null, cookies: {} }
      cached = {
        token: typeof record.payload.token === 'string' && record.payload.token.trim() !== ''
          ? record.payload.token.trim()
          : null,
        cookies: sanitizeCookies(record.payload.cookies),
      }
      return cached
    } catch {
      return { token: null, cookies: {} }
    }
  }

  async function save(next) {
    cached = next
    const store = service()
    if (store === null) return false
    try {
      await store.modifyRecord(RECORD_KEY, async () => ({
        kind: 'grant',
        payload: {
          version: RECORD_VERSION,
          ...(next.token === null ? {} : { token: next.token }),
          cookies: next.cookies,
        },
      }))
      return true
    } catch {
      return false
    }
  }

  return {
    /** 读出全部登录态。 */
    async read() {
      const value = await load()
      return { token: value.token, cookies: { ...value.cookies } }
    },

    /** 只更新 token（导入登录态时）。 */
    async writeToken(token) {
      const value = typeof token === 'string' ? token.trim() : ''
      if (value === '') return false
      const current = await load()
      return save({ token: value, cookies: current.cookies })
    },

    /** 只更新 Cookie 罐（站点自己刷新会话时）。 */
    async writeCookies(cookies) {
      const current = await load()
      return save({ token: current.token, cookies: sanitizeCookies(cookies) })
    },

    /** 是否已经存在可用的登录态。 */
    async has() {
      const value = await load()
      return value.token !== null || Object.keys(value.cookies).length > 0
    },

    /** 清掉全部登录态（用户主动退出网页版时用）。 */
    async clear() {
      cached = { token: null, cookies: {} }
      const store = service()
      if (store === null) return false
      try {
        await store.deleteRecord(RECORD_KEY)
        return true
      } catch {
        return false
      }
    },
  }
}
