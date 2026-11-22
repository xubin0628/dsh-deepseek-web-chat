/**
 * dsh-deepseek-web-chat · 浏览器半边
 *
 * 侧栏加一个「网页版 DeepSeek」入口，主区域整页显示官网（走 Host 半边的回环反代）。
 * 顶栏只有一行：标题 + 地址 + 刷新 / 新标签页 / 导入登录态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'deepseek-web'
    const NS = 'deepseek-web-chat'
    const ENDPOINT = '/deepseek-web/api/endpoint'
    const SESSION = '/deepseek-web/api/session'

    const DICT = {
      en: {
        title: 'DeepSeek Web',
        hint: 'Free web app, signed in as you.',
        loading: 'Starting the local proxy…',
        loadingFrame: 'Loading DeepSeek…',
        failed: 'The local proxy is not available.',
        failedPort: 'Port {port} did not start. It may be taken by another program.',
        retry: 'Retry',
        reload: 'Reload page',
        openTab: 'Open in a new tab',
        importToken: 'Import sign-in',
        importHint: 'Stuck on a captcha? Copy localStorage.userToken from a signed-in chat.deepseek.com tab (F12 → Console → copy(localStorage.userToken)) and paste it here.',
        importApply: 'Apply and reload',
        importCancel: 'Cancel',
        importDone: 'Sign-in imported and saved. Reloading…',
        importInvalid: 'That value was rejected by DeepSeek. Check that you copied localStorage.userToken.',
        importFailed: 'Could not import that value.',
        placeholder: 'localStorage.userToken',
        captcha: 'Captcha not passing? Use Import sign-in.',
        signInBanner: 'Sign in once — this is remembered after a restart.',
        forgotSaved: 'Forget saved sign-in',
        forgotDone: 'Saved sign-in removed.',
      },
      zh: {
        title: '网页版 DeepSeek',
        hint: '免费网页版，用你自己的登录态。',
        loading: '正在启动本机代理…',
        loadingFrame: '正在加载 DeepSeek…',
        failed: '本机代理还没起来。',
        failedPort: '端口 {port} 没能启动，可能被别的程序占用了。',
        retry: '重试',
        reload: '重新加载',
        openTab: '在新标签页打开',
        importToken: '导入登录态',
        importHint: '验证码过不去？在已登录的 chat.deepseek.com 标签页里按 F12 → Console → 输入 copy(localStorage.userToken)，再把复制到的值粘到下面。',
        importApply: '写入并重载',
        importCancel: '取消',
        importDone: '登录态已保存，正在重载…',
        importInvalid: 'DeepSeek 拒绝了这个值，确认复制的是 localStorage.userToken。',
        importFailed: '导入失败，检查一下粘贴的内容。',
        placeholder: 'localStorage.userToken',
        captcha: '验证码过不去？用「导入登录态」。',
        signInBanner: '登录一次即可，重启后仍保留。',
        forgotSaved: '清除已保存的登录态',
        forgotDone: '已清除保存的登录态。',
      },
    }

    const ICON = h('svg', {
      width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      h('circle', { cx: '12', cy: '12', r: '8.6' }),
      h('path', { d: 'M3.4 12h17.2' }),
      h('path', { d: 'M12 3.4c2.4 2.3 3.6 5.2 3.6 8.6S14.4 18.3 12 20.6C9.6 18.3 8.4 15.4 8.4 12S9.6 5.7 12 3.4z' }))

    const GLYPH = {
      reload: h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' })),
      external: h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M14 4h6v6' }), h('path', { d: 'M20 4l-9 9' }), h('path', { d: 'M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' })),
    }

    /** 组件内样式：用前缀类，焦点环 / hover 这类伪类只能靠样式表表达。 */
    const CSS = `
      .dswc-bar { display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
        padding: 0 10px; min-height: 44px; box-sizing: border-box;
        border-bottom: 0.5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-1); }
      .dswc-name { font-size: 13px; font-weight: 600; line-height: 20px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; }
      .dswc-addr { font-size: 11.5px; color: var(--dsw-alias-label-tertiary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        flex: 1 1 auto; min-width: 0; font-variant-numeric: tabular-nums; }
      .dswc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        height: 28px; padding: 0 10px; font: inherit; font-size: 12px; line-height: 1;
        color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
        transition: background-color .15s ease, color .15s ease, border-color .15s ease; }
      .dswc-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dswc-icon { width: 28px; height: 28px; padding: 0; border-color: transparent; text-decoration: none; }
      .dswc-btn:focus-visible, .dswc-input:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dswc-shell { display: flex; flex-direction: column; height: 100%; min-height: 0;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dswc-body { position: relative; flex: 1 1 auto; min-height: 0; }
      .dswc-frame { width: 100%; height: 100%; border: 0; display: block;
        background: var(--dsw-alias-bg-base); }
      .dswc-center { position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; }
      .dswc-muted { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); margin: 0; }
      .dswc-error { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-state-error-primary); margin: 0; }
      .dswc-spin { width: 18px; height: 18px; border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
        animation: dswc-spin .8s linear infinite; }
      @keyframes dswc-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .dswc-spin { animation-duration: 2.4s; } }
      .dswc-panel { display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto;
        padding: 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-2); }
      .dswc-row { display: flex; align-items: center; gap: 8px; }
      .dswc-row .dswc-input { flex: 1 1 auto; min-width: 0; }
      .dswc-input { height: 28px; padding: 0 8px; box-sizing: border-box; font: inherit;
        font-size: 12px; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px; }
      .dswc-linkbtn { font: inherit; font-size: 11.5px; padding: 0; cursor: pointer;
        color: var(--dsw-alias-label-secondary); background: none; border: 0; text-decoration: underline;
        text-underline-offset: 2px; }
      .dswc-linkbtn:hover { color: var(--dsw-alias-label-primary); }
    `

    function apply(ctx) {
      let t = (key) => (DICT.en[key] ?? key)
      ctx.inject(['locale'], (c) => {
        c.effect(() => c.locale.register(NS, 'en', DICT.en))
        c.effect(() => c.locale.register(NS, 'zh', DICT.zh))
        const bind = c.locale.bind(NS)
        t = (key) => {
          const value = bind(key)
          // 未登记的语种按 key 回落到英文
          return value === key ? (DICT.en[key] ?? key) : value
        }
      })
      const tr = (key, vars) => {
        const text = t(key)
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
      }

      function Icon(props) {
        const size = (props && props.size) || 18
        return React.cloneElement(ICON, { width: size, height: size })
      }

      function Panel() {
        const [state, setState] = React.useState({ kind: 'loading', url: '', port: 0 })
        const [attempts, setAttempts] = React.useState(0)
        const [frame, setFrame] = React.useState({ loaded: false, nonce: 0 })
        const [importing, setImporting] = React.useState(false)
        const [value, setValue] = React.useState('')
        const [notice, setNotice] = React.useState(null)
        const [saved, setSaved] = React.useState(false)
        const inputRef = React.useRef(null)

        React.useEffect(() => {
          let cancelled = false
          let timer = 0
          const attempt = (tries) => {
            fetch(ENDPOINT, { cache: 'no-store' })
              .then((response) => response.json())
              .then((data) => {
                if (cancelled) return
                if (data && data.ok && typeof data.url === 'string') {
                  setState({ kind: 'ready', url: data.url, port: Number(data.port) || 0 })
                } else if (tries > 0) timer = setTimeout(() => attempt(tries - 1), 700)
                else setState({ kind: 'failed', url: '', port: Number(data && data.port) || 0 })
              })
              .catch(() => {
                if (cancelled) return
                if (tries > 0) timer = setTimeout(() => attempt(tries - 1), 700)
                else setState({ kind: 'failed', url: '', port: 0 })
              })
          }
          attempt(12)
          return () => { cancelled = true; clearTimeout(timer) }
        }, [attempts])

        // 导入面板展开后把焦点放进输入框；Esc 收起。
        React.useEffect(() => {
          if (importing && inputRef.current) inputRef.current.focus()
        }, [importing])

        // 登录态现状 + 微信扫码前置条件：都只读，探测失败不影响主流程。
        React.useEffect(() => {
          let cancelled = false
          fetch(SESSION, { cache: 'no-store' })
            .then((response) => response.json())
            .then((data) => { if (!cancelled && data && data.ok) setSaved(data.saved === true) })
            .catch(() => {})
          return () => { cancelled = true }
        }, [])

        // 兜底：跨站 iframe 的 load 万一不触发，别让遮罩把面板永久盖住。
        React.useEffect(() => {
          if (frame.loaded || state.kind !== 'ready') return
          const timer = setTimeout(() => setFrame((f) => (f.loaded ? f : { ...f, loaded: true })), 15000)
          return () => clearTimeout(timer)
        }, [frame.loaded, frame.nonce, state.kind])

        const submit = () => {
          const token = value.trim()
          if (token === '') return
          setNotice(null)
          fetch(SESSION, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
            .then((response) => response.json().then((data) => ({ status: response.status, data })))
            .then(({ status, data }) => {
              if (data && data.ok) {
                setValue('')
                setImporting(false)
                setSaved(true)
                setNotice({ kind: 'ok', text: tr('importDone') })
                setFrame((f) => ({ loaded: false, nonce: f.nonce + 1 }))
                return
              }
              if (status === 422) setNotice({ kind: 'error', text: tr('importInvalid') })
              else setNotice({ kind: 'error', text: tr('importFailed') })
            })
            .catch(() => setNotice({ kind: 'error', text: tr('importFailed') }))
        }

        const forget = () => {
          setNotice(null)
          fetch(SESSION, { method: 'DELETE' })
            .then((response) => response.json())
            .then(() => {
              setSaved(false)
              setNotice({ kind: 'ok', text: tr('forgotDone') })
            })
            .catch(() => setNotice({ kind: 'error', text: tr('importFailed') }))
        }

        const reload = () => setFrame((f) => ({ loaded: false, nonce: f.nonce + 1 }))

        const ready = state.kind === 'ready'
        const overlay = ready && !frame.loaded
          ? h('div', { className: 'dswc-center', role: 'status' },
            h('div', { className: 'dswc-spin', 'aria-hidden': true }),
            h('p', { className: 'dswc-muted' }, tr('loadingFrame')))
          : state.kind === 'loading'
            ? h('div', { className: 'dswc-center', role: 'status' },
              h('div', { className: 'dswc-spin', 'aria-hidden': true }),
              h('p', { className: 'dswc-muted' }, tr('loading')))
            : state.kind === 'failed'
              ? h('div', { className: 'dswc-center' },
                h('p', { className: 'dswc-error', role: 'alert' }, tr('failed')),
                state.port > 0 ? h('p', { className: 'dswc-muted' }, tr('failedPort', { port: state.port })) : null,
                h('button', { type: 'button', className: 'dswc-btn', onClick: () => { setState({ kind: 'loading', url: '', port: 0 }); setAttempts((n) => n + 1) } }, tr('retry')))
              : null

        return h('section', { className: 'dswc-shell', 'aria-label': tr('title') },
          h('style', null, CSS),
          h('div', {
            className: 'dswc-bar',
            // macOS：窗口红绿灯横在内容上方，入口页要把这条安全带让出来。
            style: { paddingTop: 'var(--dsh-frame-top-clearance, 0px)' },
          },
            h(Icon, { size: 16 }),
            h('span', { className: 'dswc-name' }, tr('title')),
            h('span', { className: 'dswc-addr' }, ready ? state.url : ''),
            ready
              ? h('button', {
                type: 'button', className: 'dswc-btn dswc-icon', title: tr('reload'), 'aria-label': tr('reload'),
                onClick: reload,
              }, GLYPH.reload)
              : null,
            ready
              ? h('a', {
                href: state.url, target: '_blank', rel: 'noreferrer noopener',
                className: 'dswc-btn dswc-icon', title: tr('openTab'), 'aria-label': tr('openTab'),
              }, GLYPH.external)
              : null,
            h('button', {
              type: 'button', className: 'dswc-btn',
              'aria-expanded': importing,
              onClick: () => { setImporting((open) => !open); setNotice(null) },
            }, tr('importToken'))),
          importing
            ? h('div', {
              className: 'dswc-panel',
              onKeyDown: (event) => { if (event.key === 'Escape') { setImporting(false); setNotice(null) } },
            },
              h('p', { className: 'dswc-muted', id: 'dswc-import-hint' }, tr('importHint')),
              h('div', { className: 'dswc-row' },
                h('input', {
                  ref: inputRef,
                  className: 'dswc-input',
                  type: 'password',
                  autoComplete: 'off',
                  spellCheck: false,
                  placeholder: tr('placeholder'),
                  'aria-label': tr('importToken'),
                  'aria-describedby': 'dswc-import-hint',
                  value,
                  onChange: (event) => setValue(event.currentTarget.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') submit() },
                }),
                h('button', { type: 'button', className: 'dswc-btn', onClick: submit }, tr('importApply')),
                h('button', { type: 'button', className: 'dswc-btn', onClick: () => { setImporting(false); setNotice(null) } }, tr('importCancel'))))
            : null,
          notice
            ? h('div', { className: 'dswc-panel', role: 'status' },
              h('p', { className: notice.kind === 'error' ? 'dswc-error' : 'dswc-muted' }, notice.text))
            : null,
          ready
            ? h('div', { className: 'dswc-panel', style: { flexDirection: 'row', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { className: 'dswc-muted', style: { fontSize: '11.5px' } }, tr('captcha')),
              h('button', {
                type: 'button', className: 'dswc-linkbtn',
                onClick: () => { setImporting(true); setNotice(null) },
              }, tr('importToken')),
              h('span', { className: 'dswc-muted', style: { fontSize: '11.5px', marginLeft: 'auto' } },
                saved ? tr('signInBanner') : null),
              saved
                ? h('button', { type: 'button', className: 'dswc-linkbtn', onClick: forget }, tr('forgotSaved'))
                : null)
            : null,
          h('div', { className: 'dswc-body' },
            ready
              ? h('iframe', {
                key: `${state.url}#${frame.nonce}`,
                className: 'dswc-frame',
                src: state.url,
                title: tr('title'),
                allow: 'clipboard-write; fullscreen',
                referrerPolicy: 'no-referrer',
                onLoad: () => setFrame((f) => ({ ...f, loaded: true })),
              })
              : null,
            overlay))
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL, order: 7, label: () => tr('title') },
        Icon,
      ))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Panel))
    }

    return { apply, inject: ['slots'] }
  },
})
