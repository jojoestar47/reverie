import type { SupabaseClient } from '@supabase/supabase-js'

interface TokenRow {
  access_token:  string
  refresh_token: string
  expires_at:    string
}

/** Returns a valid Spotify access token for the given user, refreshing if expired. */
export async function getSpotifyToken(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const result = await getSpotifyTokenWithExpiry(supabase, userId)
  return result?.access_token ?? null
}

/** Like getSpotifyToken but also returns the absolute expiration timestamp
 *  so callers (e.g. the /api/spotify/token route) can pass it to the
 *  browser, letting the client cache the token instead of hammering the
 *  rate-limited endpoint on every play. */
export async function getSpotifyTokenWithExpiry(
  supabase: SupabaseClient,
  userId: string
): Promise<{ access_token: string; expires_at: string } | null> {
  const { data } = await supabase
    .from('spotify_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .single<TokenRow>()

  if (!data) return null

  // Return cached token if still valid (with 60s buffer)
  if (new Date(data.expires_at).getTime() - 60_000 > Date.now()) {
    return { access_token: data.access_token, expires_at: data.expires_at }
  }

  const refreshed = await refreshSpotifyToken(supabase, userId, data.refresh_token)
  if (!refreshed) return null
  // Re-read so we get the rotated expires_at written by the refresh
  const { data: fresh } = await supabase
    .from('spotify_tokens')
    .select('access_token, expires_at')
    .eq('user_id', userId)
    .single<{ access_token: string; expires_at: string }>()
  if (!fresh) return null
  return { access_token: fresh.access_token, expires_at: fresh.expires_at }
}

// Module-level dedup map — if a refresh is already in-flight for a userId,
// return the same promise instead of kicking off a second concurrent refresh
// that could clobber the newly-rotated refresh_token in the DB.
const refreshInFlight = new Map<string, Promise<string | null>>()

async function refreshSpotifyToken(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string
): Promise<string | null> {
  if (refreshInFlight.has(userId)) return refreshInFlight.get(userId)!

  const p = doRefreshSpotifyToken(supabase, userId, refreshToken)
  refreshInFlight.set(userId, p)
  try {
    return await p
  } finally {
    refreshInFlight.delete(userId)
  }
}

async function doRefreshSpotifyToken(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string
): Promise<string | null> {
  const clientId     = process.env.SPOTIFY_CLIENT_ID!
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET!

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) return null

  const { access_token, expires_in, refresh_token: newRefresh } = await res.json()
  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString()

  await supabase.from('spotify_tokens').update({
    access_token,
    expires_at,
    ...(newRefresh ? { refresh_token: newRefresh } : {}),
  }).eq('user_id', userId)

  return access_token
}
