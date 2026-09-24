import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { Plugin } from 'vite'
import { createApi } from '../shared/api.ts'
import { createNodeClient } from './client.ts'

const handler = getRequestListener(createApi(createNodeClient, process.env.X_MIGRATE_ORIGIN).fetch)

export function xApiNodeHandler(request: IncomingMessage, response: ServerResponse): void {
  void handler(request, response)
}

export function xApiPlugin(): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith('/api/')) return next()
    xApiNodeHandler(request, response)
  }
  return {
    name: 'x-migrate-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
