import { createGroupRoute, ROUTE_PATH } from './lib/http.js'
import { createOps } from './lib/ops.js'
import { GroupStore } from './lib/store.js'
import { createGroupTools } from './lib/tools.js'

export const name = 'dsh-group-chat'

/** Tools for the agent, the HTTP carrier, cwd defaults, and the native member route. */
export const inject = ['tools', 'webServer', 'workingDirectory', 'llm', 'agentDefaultModel']

export function apply(ctx, config) {
  const store = new GroupStore()
  // Groups created from the panel get no cwd argument, so fall back to the
  // Harness default working directory rather than the host process cwd.
  const defaultCwd = ctx.workingDirectory?.defaultDirectory
  // A `dsh` member is a plain model call on the session's own route.
  let selection
  try {
    selection = ctx.agentDefaultModel.currentSelection()
  } catch {
    selection = undefined
  }
  const ops = createOps({
    store,
    config: {
      ...(config || {}),
      defaultCwd,
      resolveCwd: (agent) => ctx.workingDirectory.get(agent.session),
      llm: ctx.llm,
      dshProvider: selection?.provider,
      dshModel: selection?.model,
    },
  })
  const definitions = createGroupTools({ ops })
  const route = createGroupRoute({ ops })

  ctx.effect(() => {
    const disposers = definitions.map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    }
  })

  // Prefix routes match pathname === path or pathname.startsWith(path + '/'),
  // so the registered path carries no trailing slash.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: route.handler }))

  // The panel reads this token from the authenticated page and returns it as a header.
  ctx.effect(() => ctx.webServer.tapIndex(route.injectToken))
}
