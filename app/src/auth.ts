// atproto OAuth, entirely in the browser.
//
// There is no backend, so there is no client secret to protect. The client is
// identified instead by a metadata document served at a public HTTPS URL, and
// that URL is the client_id. Tokens are DPoP-bound and held in IndexedDB by the
// library; nothing about the user reaches any server of ours, because we do not
// have one.

import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { FLIGHT_NSID, TRIP_NSID } from './lexicon.ts'

/**
 * Least privilege: create and update on exactly two collections, and nothing
 * else. Not delete -- the importer never removes a record. Not
 * `transition:generic`, which would grant write access to the entire
 * repository for a tool that writes flights.
 */
export const SCOPE = [
  'atproto',
  `repo:${FLIGHT_NSID}?action=create&action=update`,
  `repo:${TRIP_NSID}?action=create&action=update`,
].join(' ')

export const PRODUCTION_ORIGIN = 'https://contrail.airplaneian.com'

/**
 * In development the atproto spec allows a loopback client, where the client_id
 * carries the redirect and scope as query parameters instead of pointing at a
 * hosted document. Requires the dev server be reached over 127.0.0.1 rather
 * than localhost.
 */
function clientId(): string {
  const { origin, hostname } = window.location
  if (hostname === '127.0.0.1' || hostname === '[::1]') {
    const params = new URLSearchParams({ redirect_uri: `${origin}/`, scope: SCOPE })
    return `http://localhost?${params}`
  }
  return `${origin}/client-metadata.json`
}

let client: BrowserOAuthClient | undefined

export interface AuthState {
  session?: OAuthSession
  /** Set when a sign-in attempt failed, for display. */
  error?: string
}

/** Restore an existing session, or finish one that is mid-redirect. */
export async function initAuth(): Promise<AuthState> {
  client = await BrowserOAuthClient.load({
    clientId: clientId(),
    handleResolver: 'https://bsky.social',
  })
  try {
    const result = await client.init()
    return { session: result?.session }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Begin sign-in. Redirects away from the page and does not return. */
export async function signIn(handle: string): Promise<never> {
  if (!client) throw new Error('Auth not initialised')
  return client.signInRedirect(handle.trim().replace(/^@/, ''), { scope: SCOPE })
}

export async function signOut(session: OAuthSession): Promise<void> {
  await client?.revoke(session.did)
}
