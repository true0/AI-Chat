/**
 * The panel's HTTP surface.
 *
 * Two framework facts drive this shape:
 * - a `resource` route answers GET/HEAD only and receives no `peer`, so writes and
 *   identity checks need a raw `handler` route;
 * - a prefix route matches `pathname === prefix || pathname.startsWith(prefix + '/')`,
 *   so the registered path must have no trailing slash.
 *
 * Authorization is a per-process token injected into the authenticated index page:
 * a cross-origin page cannot read it and cannot send a custom header without a
 * preflight this route never approves.
 */
import { randomBytes } from 'node:crypto'

export const ROUTE_PATH = '/group-chat/api'
export const TOKEN_GLOBAL = '__GROUP_CHAT_TOKEN__'

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2_000_000) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createGroupRoute({ ops }) {
  const token = randomBytes(24).toString('hex')

  const handler = async (req, res) => {
    try {
      // A raw handler route receives no Peer. The listener is loopback-only, so the
      // real boundary is a foreign Origin: browsers always attach Origin to a
      // cross-site request, and it will not match this server's Host.
      const host = req.headers.host || ''
      const origin = (req.headers.origin || '').trim()
      const tokenOk = req.headers['x-group-chat-token'] === token
      const foreignOrigin = origin !== '' && (origin === 'null' || !origin.endsWith(host))
      if (!tokenOk && foreignOrigin) {
        send(res, 403, { error: 'owner only' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+|\/+$/g, '')
      const parts = rest ? rest.split('/') : []
      const method = (req.method || 'GET').toUpperCase()

      if (method === 'GET' && rest === 'state') {
        send(res, 200, ops.listState())
        return
      }

      if (method === 'GET' && rest === 'sessions') {
        send(
          res,
          200,
          ops.listSessions({
            channel: url.searchParams.get('channel') || undefined,
            limit: Number(url.searchParams.get('limit')) || 20,
          }),
        )
        return
      }

      if (method === 'GET' && rest === 'archive') {
        send(res, 200, ops.listArchives())
        return
      }

      if (parts[0] === 'archive' && parts[1] && method === 'POST' && parts[2] === 'restore') {
        send(res, 200, ops.restoreGroup({ groupId: decodeURIComponent(parts[1]) }))
        return
      }

      if (method === 'POST' && rest === 'groups') {
        send(res, 201, ops.createGroup(await readBody(req)))
        return
      }

      if (parts[0] === 'groups' && parts[1]) {
        const groupId = decodeURIComponent(parts[1])

        if (method === 'GET' && parts[2] === 'transcript') {
          send(
            res,
            200,
            ops.transcript({
              groupId,
              sinceSeq: Number(url.searchParams.get('since')) || 0,
              limit: Number(url.searchParams.get('limit')) || 50,
            }),
          )
          return
        }

        if (method === 'POST' && parts[2] === 'members') {
          send(res, 201, ops.addMember({ ...(await readBody(req)), groupId }))
          return
        }

        if (method === 'POST' && parts[2] === 'say') {
          const body = await readBody(req)
          // A Codex member can take two minutes; the panel polls the transcript,
          // so the request returns as soon as the turn is accepted.
          send(res, 202, ops.startSay({ groupId, text: body.text, memberIds: body.memberIds }))
          return
        }

        if (method === 'GET' && parts[2] === 'status') {
          send(res, 200, ops.status({ groupId }))
          return
        }

        if (method === 'GET' && parts[2] === 'usage') {
          send(res, 200, ops.usage({ groupId }))
          return
        }

        if (method === 'POST' && parts[2] === 'cancel') {
          send(res, 200, ops.cancelSay({ groupId }))
          return
        }

        if (method === 'GET' && parts[2] === 'export') {
          const result = ops.exportMinutes({ groupId })
          send(res, 200, result)
          return
        }

        if (method === 'POST' && parts[2] === 'remove') {
          send(res, 200, ops.removeGroup({ groupId }))
          return
        }

        if (method === 'POST' && parts[2] === 'rename') {
          const body = await readBody(req)
          send(res, 200, ops.renameGroup({ groupId, name: body.name }))
          return
        }
      }

      send(res, 404, { error: `未知接口 ${method} ${url.pathname}` })
    } catch (error) {
      send(res, 400, { error: String(error?.message || error) })
    }
  }

  const injectToken = (html) =>
    html.includes('</head>')
      ? html.replace(
          '</head>',
          `<script>globalThis.${TOKEN_GLOBAL}=${JSON.stringify(token)}</script></head>`,
        )
      : html

  return { token, handler, injectToken }
}
