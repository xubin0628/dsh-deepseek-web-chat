/**
 * 站点 Cookie 罐：网页版登录态的真正载体。
 *
 * 为什么必须持久化：chat.deepseek.com 的登录靠 HttpOnly 会话 Cookie。
 * 早期版本把罐子只放在内存里，Harness 一重启就清空，用户表现为「登录莫名其妙掉了、
 * 要反复重新登录」。现在罐子会落盘，重启后原样恢复。
 *
 * 落盘位置与加密策略：
 * - 交给调用方注入的 `persist` 回调（Host 侧写进 DSH 自己的凭据存储），本模块不碰磁盘；
 * - 存储介质是 profile 下的凭据文件，与 DSH 其它密钥同等对待；
 * - 只在 Cookie 真正变化时写一次，避免每个请求都落盘。
 *
 * 口令不透出：`snapshot()` 只在需要落盘时给出可序列化副本，`header()` 拼请求头。
 */
export class CookieJar {
  #jar = new Map()
  #dirty = false
  #persist

  /**
   * @param {{ save?: (snapshot: Record<string, { value: string, deadline: number }>) => void }} [options]
   *   `save` 在 Cookie 变化后被调用（同步节流由调用方负责），传可序列化快照。
   */
  constructor(options = {}) {
    this.#persist = typeof options.save === 'function' ? options.save : null
  }

  /** 用上次落盘的快照恢复。过期的直接丢掉，不写回。 */
  restore(snapshot) {
    if (typeof snapshot !== 'object' || snapshot === null) return 0
    const now = Date.now()
    let restored = 0
    for (const [name, entry] of Object.entries(snapshot)) {
      if (typeof name !== 'string' || name === '') continue
      if (typeof entry !== 'object' || entry === null) continue
      if (typeof entry.value !== 'string') continue
      const deadline = typeof entry.deadline === 'number' ? entry.deadline : Number.POSITIVE_INFINITY
      if (Number.isFinite(deadline) && deadline <= now) continue
      this.#jar.set(name, { value: entry.value, deadline })
      restored += 1
    }
    return restored
  }

  /** 吸收上游的 Set-Cookie（含删除语义）。 */
  absorb(setCookie) {
    if (!Array.isArray(setCookie)) return
    for (const line of setCookie) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const maxAge = /;\s*max-age=(-?\d+)/i.exec(line)
      const expires = /;\s*expires=([^;]+)/i.exec(line)
      let deadline = Number.POSITIVE_INFINITY
      if (maxAge) deadline = Date.now() + Number(maxAge[1]) * 1000
      else if (expires) deadline = Date.parse(expires[1])
      if (Number.isFinite(deadline) && deadline <= Date.now()) {
        if (this.#jar.delete(name)) this.#dirty = true
      } else {
        const previous = this.#jar.get(name)
        if (previous === undefined || previous.value !== value || previous.deadline !== deadline) {
          this.#jar.set(name, { value, deadline })
          this.#dirty = true
        }
      }
    }
    this.#flush()
  }

  /** 拼成 Cookie 请求头。 */
  header() {
    const now = Date.now()
    const parts = []
    for (const [name, entry] of this.#jar) {
      if (entry.deadline <= now) {
        this.#jar.delete(name)
        this.#dirty = true
        continue
      }
      parts.push(`${name}=${entry.value}`)
    }
    return parts.join('; ')
  }

  /** 罐里已有的 Cookie 名，用来把浏览器带来的同名 Cookie 挡在外面。 */
  names() { return new Set(this.#jar.keys()) }

  /** 可序列化快照（落盘用）。 */
  snapshot() {
    const out = {}
    for (const [name, entry] of this.#jar) out[name] = { value: entry.value, deadline: entry.deadline }
    return out
  }

  /** 罐里是否有仍然有效的会话 Cookie。 */
  hasSession() {
    const now = Date.now()
    for (const entry of this.#jar.values()) {
      if (entry.deadline > now) return true
    }
    return false
  }

  /** 清空（用户主动退出）。 */
  clear() {
    if (this.#jar.size > 0) {
      this.#jar.clear()
      this.#dirty = true
      this.#flush()
    }
  }

  #flush() {
    if (!this.#dirty || this.#persist === null) return
    this.#dirty = false
    try {
      this.#persist(this.snapshot())
    } catch {
      // 落盘失败不该影响正在进行的请求；下次变化会再试。
    }
  }
}
