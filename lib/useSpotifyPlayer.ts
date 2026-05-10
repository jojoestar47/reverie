'use client'

import { useEffect, useRef, useState } from 'react'
import type { Track, Scene } from '@/lib/types'
import type {
  SpotifySdkGlobal,
  SpotifySdkPlayer,
  SpotifySdkPlayerState,
} from '@/lib/spotify'
import { isIosWebkit } from '@/lib/platform'

export interface SpotifyTrackState {
  playing: boolean
  volume:  number
  loop:    boolean
}

export interface SpotifyNowPlaying {
  name:     string
  artist:   string
  albumArt: string | null
}

export interface SpotifyPlayerApi {
  states:     Record<string, SpotifyTrackState>
  connected:  boolean
  /**
   * True when the runtime is iOS/iPadOS WebKit, where the Spotify Web
   * Playback SDK silently fails to initialize. Consumers should display a
   * "use a desktop browser" message instead of a Connect button.
   */
  unsupported: boolean
  // Now-playing metadata, updated from the SDK's player_state_changed event
  nowPlaying: SpotifyNowPlaying | null
  // Playback position (0–1) and total duration (ms), polled every 500ms
  progress:   number
  duration:   number
  // Last error message surfaced by the SDK (auth/init/account/playback) or
  // null when healthy. Lets the UI show a "Reconnect" prompt with context
  // instead of a silent disconnect.
  lastError:  string | null
  toggle:     (t: Track) => void
  setVolume:  (t: Track, val: number) => void
  setLoop:    (t: Track, val: boolean) => void
  stopAll:    () => void
  mute:       (muted: boolean) => void
  autoPlay:   () => void   // call after user interaction (viewer tap-to-start)
  skip:       (direction: 'next' | 'previous') => void
  /**
   * Smooth track-switch: fade the currently-active Spotify track down to 0,
   * start the new one at 0, then ramp up to its target volume. Hides the
   * inevitable network-roundtrip gap when /me/player/play swaps the URI.
   */
  fadeTo:     (t: Track, durationMs?: number) => Promise<void>
  /** Ramp Spotify volume to 0 then pause — used when crossfading from a
   *  Spotify track to a file track. */
  fadeOut:    (durationMs?: number) => Promise<void>
  // Manual reconnect — re-runs player.connect() which usually re-fires the
  // 'ready' event without a full re-auth. Falls back to no-op if the SDK
  // never loaded.
  reconnect:  () => void
}

declare global {
  interface Window {
    Spotify: SpotifySdkGlobal
    onSpotifyWebPlaybackSDKReady: () => void
  }
}

// ── localStorage helpers ──────────────────────────────────────
function loadSavedVolume(sceneId: string, trackId: string, fallback: number): number {
  try {
    const saved = JSON.parse(localStorage.getItem(`sf_vol_${sceneId}`) || '{}')
    return typeof saved[trackId] === 'number' ? saved[trackId] : fallback
  } catch { return fallback }
}

function saveVolume(sceneId: string, trackId: string, volume: number) {
  try {
    const key   = `sf_vol_${sceneId}`
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    saved[trackId] = volume
    localStorage.setItem(key, JSON.stringify(saved))
  } catch {}
}

// ── Server token fetch ────────────────────────────────────────
// Module-level cache so every call site (SDK getOAuthToken callback,
// playTrack, applyRepeatMode, skip) shares one valid token instead of
// each round-tripping /api/spotify/token. Spotify access tokens are
// valid for ~1 hour; we honor expires_at minus a 60s buffer.
//
// Without this cache, DM + viewer on the same account easily blew past
// the endpoint's rate limit (the SDK calls getOAuthToken on connect AND
// every play — multiplied by tabs), which surfaced as "won't connect to
// Spotify" because token fetch returned null.
let cachedToken: { access_token: string; expires_at: number } | null = null
let inFlight: Promise<string | null> | null = null

function readCachedToken(): string | null {
  if (!cachedToken) return null
  if (cachedToken.expires_at - 60_000 <= Date.now()) {
    cachedToken = null
    return null
  }
  return cachedToken.access_token
}

async function fetchToken(): Promise<string | null> {
  const cached = readCachedToken()
  if (cached) return cached
  // De-dupe parallel fetches so a burst of playTrack calls only hits the
  // endpoint once.
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const res = await fetch('/api/spotify/token')
      if (!res.ok) {
        // 401 = not connected, 429 = rate limited, 5xx = upstream — without
        // surfacing this every disconnect looks identical to "user pressed stop."
        console.warn(`[spotify] /api/spotify/token failed: ${res.status} ${res.statusText}`)
        return null
      }
      const { access_token, expires_at } = await res.json() as { access_token?: string; expires_at?: string }
      if (!access_token) return null
      const expMs = expires_at ? new Date(expires_at).getTime() : Date.now() + 50 * 60_000
      cachedToken = { access_token, expires_at: expMs }
      return access_token
    } catch (e) {
      console.warn('[spotify] /api/spotify/token network error:', e)
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// Force the next fetchToken to round-trip — call when the SDK reports an
// auth error so we don't hand it the same dead token.
function invalidateCachedToken() {
  cachedToken = null
}

// ── Repeat mode helper ────────────────────────────────────────
async function applyRepeatMode(
  loop:        boolean,
  spotifyType: string | undefined,
  deviceId:    string,
  token:       string
): Promise<void> {
  const state = !loop
    ? 'off'
    : spotifyType === 'playlist' ? 'context' : 'track'
  await fetch(
    `https://api.spotify.com/v1/me/player/repeat?state=${state}&device_id=${deviceId}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => {})
}

export function useSpotifyPlayer(
  scene: Scene | null,
  { disableAutoPlay = false, preferredTrackId = null }: { disableAutoPlay?: boolean; preferredTrackId?: string | null } = {},
): SpotifyPlayerApi {
  const playerRef      = useRef<SpotifySdkPlayer | null>(null)
  const deviceIdRef    = useRef<string | null>(null)
  const activeTrackRef = useRef<Track | null>(null)
  const loopRef        = useRef<Record<string, boolean>>({})
  const volumeRef      = useRef<Record<string, number>>({})
  const mutedRef       = useRef(false)
  const prevSceneIdRef = useRef<string | null>(null)
  // If play is requested before the device is ready, we queue the track here
  // and flush it as soon as the 'ready' event fires.
  const pendingPlayRef = useRef<Track | null>(null)

  const [connected,   setConnected]   = useState(false)
  const [lastError,   setLastError]   = useState<string | null>(null)
  const [states,      setStates]      = useState<Record<string, SpotifyTrackState>>({})
  const [nowPlaying,  setNowPlaying]  = useState<SpotifyNowPlaying | null>(null)
  const [progress,    setProgress]    = useState(0)
  const [duration,    setDuration]    = useState(0)
  // One-shot platform check. The SDK's `connect()` resolves successfully on
  // iOS but no `ready` event ever fires, so we'd otherwise spin forever
  // showing "Connecting…". Detect up-front and skip SDK load entirely.
  const [unsupported] = useState(() => isIosWebkit())

  const spotifyTracks = (scene?.tracks ?? []).filter(t => !!t.spotify_uri)

  // ── Initialize per-track state on scene change ────────────────
  useEffect(() => {
    if (scene?.id === prevSceneIdRef.current) return
    prevSceneIdRef.current = scene?.id ?? null

    if (playerRef.current) playerRef.current.pause().catch(() => {})
    activeTrackRef.current = null
    setNowPlaying(null)
    setProgress(0)
    setDuration(0)

    const init: Record<string, SpotifyTrackState> = {}
    spotifyTracks.forEach(t => {
      const vol = scene?.id
        ? loadSavedVolume(scene.id, t.id, t.volume)
        : t.volume
      loopRef.current[t.id]   = t.loop
      volumeRef.current[t.id] = vol
      init[t.id] = { playing: false, volume: vol, loop: t.loop }
    })
    setStates(init)
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-play music tracks when SDK connects ─────────────────
  // Disabled on the DM stage (disableAutoPlay=true) so only the viewer
  // device drives Spotify playback. Both pages create a virtual Spotify
  // device; if both auto-play on scene change they race — last write wins
  // and the wrong device may end up with audio. The DM can still manually
  // toggle tracks from the mixer.
  //
  // preferredTrackId lets callers (the viewer) specify the DM-selected
  // track up-front so on initial connect we play the right one. It's read
  // through a ref so a *change* in preferredTrackId doesn't re-fire this
  // effect — that was the bug behind "plays for a second and then
  // restarts": each DM-initiated track switch updates preferredTrackId,
  // which used to re-trigger this effect, which scheduled a duplicate
  // playTrack() 350ms later. Spotify's /me/player/play with the same URI
  // restarts the track from the beginning, so the listener heard the new
  // track for ~350ms (until the timer fired) and then it restarted.
  //
  // The activeTrackRef guard inside the timer is a second line of defense:
  // even if this effect somehow re-fires while a track is playing, we
  // don't clobber it with another playTrack(). fadeTo()/toggle() set
  // activeTrackRef when they kick off playback, so we can detect it.
  const preferredTrackIdRef = useRef(preferredTrackId)
  useEffect(() => { preferredTrackIdRef.current = preferredTrackId }, [preferredTrackId])

  useEffect(() => {
    if (disableAutoPlay || !connected || !scene?.id) return
    const music = spotifyTracks.filter(
      t => t.kind === 'music' || t.kind === 'ml2' || t.kind === 'ml3'
    )
    if (!music.length) return
    const target = (preferredTrackIdRef.current ? music.find(t => t.id === preferredTrackIdRef.current) : null) ?? music[0]
    const timer = setTimeout(() => {
      if (activeTrackRef.current) return
      playTrack(target).catch(() => {})
    }, 350)
    return () => clearTimeout(timer)
  }, [scene?.id, connected, disableAutoPlay]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Progress polling (500ms) ──────────────────────────────────
  // player_state_changed alone isn't frequent enough for a smooth bar.
  useEffect(() => {
    if (!connected) return
    const interval = setInterval(async () => {
      if (!playerRef.current) return
      const state = await playerRef.current.getCurrentState().catch(() => null)
      if (!state || state.paused || state.duration === 0) return
      setProgress(state.position / state.duration)
      setDuration(state.duration)
    }, 500)
    return () => clearInterval(interval)
  }, [connected])

  // ── Load SDK on mount ─────────────────────────────────────────
  useEffect(() => {
    // iOS/iPadOS WebKit: SDK is non-functional. Skip the script load and the
    // pointless network call so consumers can render an "unsupported" state
    // immediately.
    if (unsupported) return
    fetch('/api/spotify/token').then(r => {
      if (r.ok) loadSDK()
    }).catch(() => {})

    function loadSDK() {
      if (window.Spotify) { initPlayer(); return }
      if (!document.getElementById('spotify-sdk')) {
        const script  = document.createElement('script')
        script.id     = 'spotify-sdk'
        script.src    = 'https://sdk.scdn.co/spotify-player.js'
        script.async  = true
        document.body.appendChild(script)
      }
      window.onSpotifyWebPlaybackSDKReady = initPlayer
    }

    function initPlayer() {
      if (playerRef.current) return
      const player = new window.Spotify.Player({
        name: 'Reverie',
        getOAuthToken: async (cb: (token: string) => void) => {
          const token = await fetchToken()
          if (token) cb(token)
        },
        volume: 0.7,
      })

      player.addListener('ready', ({ device_id }: { device_id: string }) => {
        console.log('[spotify] ready, device_id =', device_id)
        deviceIdRef.current = device_id
        setConnected(true)
        setLastError(null)
        // Flush any play that was requested before the device was ready
        if (pendingPlayRef.current) {
          const queued = pendingPlayRef.current
          pendingPlayRef.current = null
          setTimeout(() => playTrack(queued).catch(() => {}), 350)
        }
      })

      player.addListener('not_ready', ({ device_id }: { device_id: string }) => {
        console.warn('[spotify] not_ready, device_id =', device_id, '(SDK lost the device — usually a network blip or the user activating Spotify on another device)')
        deviceIdRef.current = null
        setConnected(false)
      })

      // Diagnostic listeners — without these, every SDK failure is silent.
      // Surface them via console + lastError so the UI can prompt to reconnect.
      const onSdkError = (kind: string) => (e: { message?: string }) => {
        const msg = e?.message ?? kind
        console.error(`[spotify] ${kind}:`, msg)
        setLastError(`${kind}: ${msg}`)
        if (kind === 'authentication_error' || kind === 'account_error') {
          setConnected(false)
          // Drop the cached token so the next fetch round-trips and we
          // don't keep handing the SDK the same expired/invalid one.
          invalidateCachedToken()
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = player as any
      p.addListener('initialization_error',  onSdkError('initialization_error'))
      p.addListener('authentication_error',  onSdkError('authentication_error'))
      p.addListener('account_error',         onSdkError('account_error'))
      p.addListener('playback_error',        onSdkError('playback_error'))
      p.addListener('autoplay_failed',       () => {
        console.warn('[spotify] autoplay_failed — browser blocked SDK autoplay; user must click play once')
        setLastError('autoplay blocked — click play in the mixer')
      })

      player.addListener('player_state_changed', (state: SpotifySdkPlayerState | null) => {
        if (!state || !activeTrackRef.current) return
        const t = activeTrackRef.current

        setStates(prev => ({
          ...prev,
          [t.id]: { ...prev[t.id], playing: !state.paused },
        }))

        // Update now-playing metadata from the SDK event payload
        const sdkTrack = state.track_window?.current_track
        if (sdkTrack) {
          setNowPlaying({
            name:     sdkTrack.name ?? '',
            artist:   sdkTrack.artists?.[0]?.name ?? '',
            albumArt: sdkTrack.album?.images?.[0]?.url ?? null,
          })
          if (state.duration > 0) {
            setDuration(state.duration)
            setProgress(state.position / state.duration)
          }
        }

        if (state.paused) {
          setProgress(state.duration > 0 ? state.position / state.duration : 0)
        }
      })

      player.connect()
      playerRef.current = player
    }

    return () => {
      if (playerRef.current) {
        playerRef.current.disconnect()
        playerRef.current = null
        setConnected(false)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Playback helpers ──────────────────────────────────────────
  async function playTrack(t: Track, opts?: { initialVolume?: number }) {
    if (!t.spotify_uri) return
    // Device not ready yet — queue the track and return. The 'ready' listener
    // will flush it once the virtual device has a device_id.
    if (!deviceIdRef.current || !playerRef.current) {
      pendingPlayRef.current = t
      return
    }

    const sceneIdAtStart = prevSceneIdRef.current
    // Claim the active-track slot up-front so concurrent calls (the
    // auto-play timer racing with a user-initiated fadeTo, both targeting
    // tracks in the same scene) check activeTrackRef and skip. Without
    // this, both call /me/player/play in quick succession and Spotify
    // restarts the second URI — that was the "starts for a second and
    // then restarts" symptom. We restore the previous value if the network
    // operation fails or the scene changes mid-flight.
    const previousActive = activeTrackRef.current
    activeTrackRef.current = t

    const token = await fetchToken()
    if (!token || prevSceneIdRef.current !== sceneIdAtStart) {
      activeTrackRef.current = previousActive
      return
    }

    const body = t.spotify_type === 'playlist'
      ? { context_uri: t.spotify_uri }
      : { uris: [t.spotify_uri] }

    const playRes = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceIdRef.current}`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      }
    )

    // 204 = success, 202 = accepted (device waking up) — anything else is a
    // real failure. Don't update local state if Spotify rejected the request,
    // or we'd show the track as playing when nothing is audible.
    if ((!playRes.ok && playRes.status !== 202) || prevSceneIdRef.current !== sceneIdAtStart) {
      activeTrackRef.current = previousActive
      return
    }

    await applyRepeatMode(
      loopRef.current[t.id] ?? false,
      t.spotify_type,
      deviceIdRef.current,
      token
    )

    setProgress(0)

    // initialVolume lets fadeTo() start the track silenced and ramp it up
    // manually instead of getting clobbered by this final setVolume.
    const vol = opts?.initialVolume ?? (mutedRef.current ? 0 : (volumeRef.current[t.id] ?? t.volume))
    await playerRef.current.setVolume(vol).catch(() => {})

    setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], playing: true } }))
  }

  // ── Volume ramp helper ────────────────────────────────────────
  // SDK has no native fade API. Step the volume in small intervals so the
  // listener perceives a smooth transition instead of a hard cut.
  async function rampVolume(from: number, to: number, durationMs: number) {
    if (!playerRef.current) return
    const STEPS = Math.max(4, Math.round(durationMs / 30))
    for (let i = 1; i <= STEPS; i++) {
      const v = from + (to - from) * (i / STEPS)
      await playerRef.current.setVolume(Math.max(0, Math.min(1, v))).catch(() => {})
      await new Promise(r => setTimeout(r, durationMs / STEPS))
    }
  }

  // ── Public API ────────────────────────────────────────────────
  function toggle(t: Track) {
    if (!t.spotify_uri || !playerRef.current) return
    const isActive  = activeTrackRef.current?.id === t.id
    const isPlaying = states[t.id]?.playing ?? false
    if (isActive && isPlaying) {
      playerRef.current.pause().catch(() => {})
      activeTrackRef.current = null
      setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], playing: false } }))
    } else {
      if (activeTrackRef.current && activeTrackRef.current.id !== t.id) {
        const prevId = activeTrackRef.current.id
        setStates(prev => ({ ...prev, [prevId]: { ...prev[prevId], playing: false } }))
      }
      playTrack(t).catch(() => {})
    }
  }

  function setVolume(t: Track, val: number) {
    volumeRef.current[t.id] = val
    if (scene?.id) saveVolume(scene.id, t.id, val)
    if (activeTrackRef.current?.id === t.id && playerRef.current && !mutedRef.current) {
      playerRef.current.setVolume(val).catch(() => {})
    }
    setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], volume: val } }))
  }

  function setLoop(t: Track, val: boolean) {
    loopRef.current[t.id] = val
    setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], loop: val } }))
    if (activeTrackRef.current?.id === t.id && deviceIdRef.current) {
      const deviceId = deviceIdRef.current
      fetchToken().then(token => {
        if (token && deviceId) applyRepeatMode(val, t.spotify_type, deviceId, token)
      }).catch(() => {})
    }
  }

  function stopAll() {
    if (playerRef.current) playerRef.current.pause().catch(() => {})
    activeTrackRef.current = null
    setNowPlaying(null)
    setProgress(0)
    setStates(prev =>
      Object.fromEntries(Object.entries(prev).map(([id, s]) => [id, { ...s, playing: false }]))
    )
  }

  function mute(muted: boolean) {
    mutedRef.current = muted
    if (!playerRef.current || !activeTrackRef.current) return
    const t   = activeTrackRef.current
    const vol = muted ? 0 : (volumeRef.current[t.id] ?? 0.7)
    playerRef.current.setVolume(vol).catch(() => {})
  }

  function autoPlay() {
    if (disableAutoPlay) return
    const music = spotifyTracks.filter(
      t => t.kind === 'music' || t.kind === 'ml2' || t.kind === 'ml3'
    )
    if (!music.length || !connected) return
    playTrack(music[0]).catch(() => {})
  }

  function skip(direction: 'next' | 'previous') {
    if (!playerRef.current) return
    if (direction === 'next') playerRef.current.nextTrack().catch(() => {})
    else                      playerRef.current.previousTrack().catch(() => {})
  }

  function reconnect() {
    if (!playerRef.current) {
      console.warn('[spotify] reconnect: SDK not loaded yet')
      return
    }
    console.log('[spotify] reconnect: calling player.connect()')
    setLastError(null)
    playerRef.current.connect()
  }

  async function fadeTo(t: Track, durationMs = 350) {
    if (!t.spotify_uri || !playerRef.current) return
    // Capture the scene generation up-front. If the user navigates away
    // (back to home, different campaign) mid-fade, prevSceneIdRef changes
    // and we abort + force-pause so the new URI doesn't keep playing on
    // the SDK's virtual device with nothing telling it to stop.
    const sceneIdAtStart = prevSceneIdRef.current
    const targetVol = mutedRef.current ? 0 : (volumeRef.current[t.id] ?? t.volume)

    if (activeTrackRef.current && activeTrackRef.current.id !== t.id) {
      const prevId = activeTrackRef.current.id
      const startVol = mutedRef.current ? 0 : (volumeRef.current[prevId] ?? targetVol)
      await rampVolume(startVol, 0, Math.round(durationMs / 2))
      if (prevSceneIdRef.current !== sceneIdAtStart) return
      setStates(prev => ({ ...prev, [prevId]: { ...prev[prevId], playing: false } }))
    }

    await playTrack(t, { initialVolume: 0 })
    // The /me/player/play fetch inside playTrack is the danger window — if
    // the scene changed while it was in flight, Spotify is now playing the
    // new URI on the device but the per-scene effect's player.pause() was
    // racing with our request. Force-pause here so audio doesn't bleed
    // through onto the next view.
    if (prevSceneIdRef.current !== sceneIdAtStart) {
      await playerRef.current.pause().catch(() => {})
      activeTrackRef.current = null
      setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], playing: false } }))
      return
    }
    await rampVolume(0, targetVol, Math.round(durationMs / 2))
  }

  async function fadeOut(durationMs = 350) {
    if (!playerRef.current || !activeTrackRef.current) return
    const t = activeTrackRef.current
    const startVol = mutedRef.current ? 0 : (volumeRef.current[t.id] ?? t.volume)
    await rampVolume(startVol, 0, durationMs)
    await playerRef.current.pause().catch(() => {})
    activeTrackRef.current = null
    setStates(prev => ({ ...prev, [t.id]: { ...prev[t.id], playing: false } }))
    // Restore the SDK volume so the next playTrack starts at the right level.
    // (playTrack will setVolume itself, but if a manual play() is invoked
    // somehow, we want sane defaults.)
    await playerRef.current.setVolume(startVol).catch(() => {})
  }

  return { states, connected, unsupported, lastError, nowPlaying, progress, duration, toggle, setVolume, setLoop, stopAll, mute, autoPlay, skip, reconnect, fadeTo, fadeOut }
}
