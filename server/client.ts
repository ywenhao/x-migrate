import { fetch as undiciFetch } from 'undici'
import { XClient, type Fetcher, type QueryIds } from '../shared/x-api.ts'
import { makeDispatcher, resolveProxyUrl } from './proxy.ts'

export async function createNodeClient(
  authToken: string,
  ct0: string,
  queryIds: QueryIds,
): Promise<XClient> {
  const dispatcher = makeDispatcher(await resolveProxyUrl())
  const request: Fetcher = (url, init) =>
    undiciFetch(url, { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>
  return XClient.create(authToken, ct0, queryIds, request, () => dispatcher.close())
}
