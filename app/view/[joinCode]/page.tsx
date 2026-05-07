'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Scene, Track, Character, CharacterState, Handout, SceneOverlay, OverlayLiveState, CampaignSound, SfxEvent } from '@/lib/types'
import type { SpotifyNowPlaying } from '@/lib/useSpotifyPlayer'
import CharacterDisplay from '@/components/CharacterDisplay'
import { characterImageUrl } from '@/lib/media'
import AppIcon from '@/components/AppIcon'
import HandoutLightbox from '@/components/HandoutLightbox'
import OverlayStack from '@/components/OverlayStack'
import { useSpotifyPlayer } from '@/lib/useSpotifyPlayer'
import { isIosWebkit } from '@/lib/platform'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

function pubUrl(media: { url?: string; storage_path?: string } | null | undefined): string | null {
  if (!media) return null
  if (media.storage_path)
    return `${SUPABASE_URL}/storage/v1/object/public/scene-media/${media.storage_path}`
  return media.url || null
}

type Status = 'loading' | 'waiting' | 'live' | 'ended'

const MIXER_BG       = 'rgba(13,14,22,0.96)'
const MIXER_BG_PANEL = 'rgba(18,20,30,0.98)'

export default function ViewerPage() {
  const params   = useParams()
  const joinCode = (params.joinCode as string).toUpperCase()
  const supabase = createClient()

  const [status, setStatus] = useState<Status>('loading')
  const [scene,  setScene]  = useState<Scene | null>(null)

  // ── Characters ────────────────────────────────────────────────
  const charLoadSeqRef = useRef(0)
  const [characters,       setCharacters]       = useState<{ left: Character | null; center: Character | null; right: Character | null }>({ left: null, center: null, right: null })
  const [viewerScales,     setViewerScales]     = useState<{ left: number; center: number; right: number }>({ left: 1, center: 1, right: 1 })
  const [viewerDisplay,    setViewerDisplay]    = useState<{
    left:   { zoom: number; panX: number; panY: number; flipped: boolean; aboveOverlay: boolean }
    center: { zoom: number; panX: number; panY: number; flipped: boolean; aboveOverlay: boolean }
    right:  { zoom: number; panX: number; panY: number; flipped: boolean; aboveOverlay: boolean }
  }>({
    left:   { zoom: 1, panX: 50, panY: 100, flipped: false, aboveOverlay: false },
    center: { zoom: 1, panX: 50, panY: 100, flipped: false, aboveOverlay: false },
    right:  { zoom: 1, panX: 50, panY: 100, flipped: false, aboveOverlay: false },
  })

  // Skip the character fetch when the JSON-serialized state is unchanged.
  // The realtime channel fires this on every session UPDATE (handout/overlay/
  // music too), so without a guard we'd re-fetch all three characters on every
  // tweak — and the periodic resync poll would do the same every cycle.
  const lastCharStateKeyRef = useRef<string | null>(null)
  const loadCharactersFromState = useCallback(async (state: CharacterState | null) => {
    const key = state ? JSON.stringify(state) : ''
    if (lastCharStateKeyRef.current === key) return
    lastCharStateKeyRef.current = key
    const seq = ++charLoadSeqRef.current
    if (!state) {
      setCharacters({ left: null, center: null, right: null })
      setViewerScales({ left: 1, center: 1, right: 1 })
      return
    }
    const fetchChar = async (id: string | null): Promise<Character | null> => {
      if (!id) return null
      const { data } = await supabase.from('characters').select('*').eq('id', id).single()
      return data as Character | null
    }
    const [l, c, r] = await Promise.all([fetchChar(state.left), fetchChar(state.center), fetchChar(state.right)])
    if (seq !== charLoadSeqRef.current) return
    setCharacters({ left: l, center: c, right: r })
    setViewerScales({
      left:   state.leftScale   ?? 1,
      center: state.centerScale ?? 1,
      right:  state.rightScale  ?? 1,
    })
    setViewerDisplay({
      left:   { zoom: state.leftZoom   ?? 1, panX: state.leftPanX   ?? 50, panY: state.leftPanY   ?? 100, flipped: state.leftFlipped   ?? false, aboveOverlay: state.leftAboveOverlay   ?? false },
      center: { zoom: state.centerZoom ?? 1, panX: state.centerPanX ?? 50, panY: state.centerPanY ?? 100, flipped: state.centerFlipped ?? false, aboveOverlay: state.centerAboveOverlay ?? false },
      right:  { zoom: state.rightZoom  ?? 1, panX: state.rightPanX  ?? 50, panY: state.rightPanY  ?? 100, flipped: state.rightFlipped  ?? false, aboveOverlay: state.rightAboveOverlay  ?? false },
    })
  }, [supabase])

  // ── Audio ─────────────────────────────────────────────────────
  type Handlers = { play: () => void; pause: () => void }
  const audioRefs             = useRef<Record<string, HTMLAudioElement>>({})
  const audioHandlers         = useRef<Record<string, Handlers>>({})
  // SFX one-shot playbacks (keyed by unique event id). Each entry carries
  // the soundId so a "stop" event from the DM can pause every in-flight
  // playback for that sound.
  const sfxAudioRef           = useRef<Record<string, { audio: HTMLAudioElement; soundId: string }>>({})
  const [volumes, setVolumes] = useState<Record<string, number>>({})
  const [playing, setPlaying] = useState<Record<string, boolean>>({})
  const [muted,   setMuted]   = useState(false)
  const mutedRef = useRef(false)
  useEffect(() => { mutedRef.current = muted }, [muted])
  const [mixerOpen, setMixerOpen] = useState(false)
  const [mixerPos, setMixerPos] = useState<'top-left' | 'top-right'>('top-left')
  useEffect(() => {
    const saved = localStorage.getItem('sf_mixer_pos') as 'top-left' | 'top-right' | null
    if (saved) setMixerPos(saved)
  }, [])
  const prevSceneIdForVolRef = useRef<string | null>(null)

  // ── Soundboard cache + last-handled SFX event id ──────────────
  const [campaignSounds, setCampaignSounds] = useState<CampaignSound[]>([])
  const campaignSoundsRef = useRef<CampaignSound[]>([])
  useEffect(() => { campaignSoundsRef.current = campaignSounds }, [campaignSounds])
  const lastSfxEventIdRef = useRef<string | null>(null)
  const [sessionCampaignId, setSessionCampaignId] = useState<string | null>(null)
  // Mirror sessionCampaignId in a ref so loadSession can decide whether to
  // refetch sounds/handouts without depending on state inside the closure.
  const sessionCampaignIdRef = useRef<string | null>(null)

  // ── Campaign Library (campaign-scoped handouts) ──
  // Players browse these themselves — independent of the DM-pushed handout.
  const [campaignHandouts, setCampaignHandouts] = useState<Handout[]>([])
  const [libraryOpen,      setLibraryOpen]      = useState(false)
  const [libraryHandout,   setLibraryHandout]   = useState<Handout | null>(null)

  const disposeRefs = useCallback((refs: Record<string, HTMLAudioElement>, handlers: Record<string, Handlers>) => {
    Object.entries(refs).forEach(([id, a]) => {
      const h = handlers[id]
      if (h) {
        a.removeEventListener('play',  h.play)
        a.removeEventListener('pause', h.pause)
      }
      a.pause(); a.src = ''
    })
  }, [])

  // Pause and discard all active <audio> elements when the viewer unmounts
  // (e.g. the user navigates away). Without this the browser keeps the audio
  // objects alive and the sounds continue playing in the background.
  useEffect(() => {
    return () => {
      disposeRefs(audioRefs.current, audioHandlers.current)
      audioRefs.current    = {}
      audioHandlers.current = {}
      Object.values(sfxAudioRef.current).forEach(({ audio }) => { try { audio.pause(); audio.src = '' } catch {} })
      sfxAudioRef.current = {}
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── SFX playback ──────────────────────────────────────────────
  // Reads `muted` via the existing mutedRef (declared above) so this callback
  // stays stable — otherwise the realtime session subscription would tear
  // down and resubscribe on every mute toggle.
  const playSfxEvent = useCallback((ev: SfxEvent, soundsList: CampaignSound[]) => {
    // Stop event: pause any in-flight playbacks of this sound
    if (ev.stop) {
      Object.entries(sfxAudioRef.current).forEach(([key, { audio, soundId }]) => {
        if (soundId !== ev.sound_id) return
        try { audio.pause(); audio.src = '' } catch {}
        delete sfxAudioRef.current[key]
      })
      return
    }
    const sound = soundsList.find(s => s.id === ev.sound_id)
    if (!sound) return
    const src = sound.signed_url
      || (sound.storage_path ? `${SUPABASE_URL}/storage/v1/object/public/scene-media/${sound.storage_path}` : null)
      || sound.url
    if (!src) return
    const a = new Audio(src)
    a.muted = mutedRef.current
    a.volume = ev.volume ?? sound.volume ?? 1
    const playbackKey = ev.id
    sfxAudioRef.current[playbackKey] = { audio: a, soundId: ev.sound_id }
    const cleanup = () => {
      if (!sfxAudioRef.current[playbackKey]) return
      delete sfxAudioRef.current[playbackKey]
      a.removeEventListener('ended', cleanup)
      a.removeEventListener('error', cleanup)
    }
    a.addEventListener('ended', cleanup)
    a.addEventListener('error', cleanup)
    // play() may reject if the browser hasn't seen a user gesture yet —
    // the mixer's manual buttons are user gestures, so there's a recovery
    // path. Silent failure here is preferable to a blocking modal.
    a.play().catch(() => { cleanup() })
  }, [])

  // ── Handout sync ─────────────────────────────────────────────
  // activeHandoutId is set by the DM via session realtime; resolved against
  // scene.handouts so it always reflects the latest scene data.
  const [activeHandoutId, setActiveHandoutId] = useState<string | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  useEffect(() => { sceneRef.current = scene }, [scene])
  const activeHandout = (scene?.handouts ?? []).find(h => h.id === activeHandoutId) ?? null

  // ── Music track sync ──────────────────────────────────────────
  // activeMusicTrackId is set by the DM when they change tracks in the mixer.
  // A ref mirrors it so the autoplay effect (which runs on scene change) can
  // read the correct starting track without needing it as a dependency.
  const [activeMusicTrackId, setActiveMusicTrackId] = useState<string | null>(null)
  const activeMusicTrackIdRef = useRef<string | null>(null)
  useEffect(() => { activeMusicTrackIdRef.current = activeMusicTrackId }, [activeMusicTrackId])

  // ── Overlay sync ──────────────────────────────────────────────
  const [activeOverlays, setActiveOverlays] = useState<Record<string, OverlayLiveState>>({})

  // ── Spotify player ────────────────────────────────────────────
  // preferredTrackId: when the DM has already chosen a track, autoplay it
  // directly so we don't briefly play music[0] before switching.
  const spotify = useSpotifyPlayer(scene, { preferredTrackId: activeMusicTrackId })

  // ── Fullscreen ────────────────────────────────────────────────
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [isFs, setIsFs] = useState(false)
  // iOS Safari has no Fullscreen API. Hide the button instead of leaving a
  // dead control on screen.
  const supportsFullscreen = !isIosWebkit()

  useEffect(() => {
    function onChange() { setIsFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement)) }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => { document.removeEventListener('fullscreenchange', onChange); document.removeEventListener('webkitfullscreenchange', onChange) }
  }, [])

  function toggleFs() {
    const el = wrapperRef.current; if (!el) return
    if (isFs) { document.exitFullscreen?.() || (document as any).webkitExitFullscreen?.() }
    else { el.requestFullscreen?.() || (el as any).webkitRequestFullscreen?.() }
  }

  // ── Audio helpers ─────────────────────────────────────────────
  function getOrCreate(t: Track): HTMLAudioElement {
    if (t.spotify_uri) return new Audio() // Spotify tracks handled by SDK
    if (!audioRefs.current[t.id]) {
      const src = pubUrl({ url: t.url || undefined, storage_path: t.storage_path || undefined }) || ''
      const a   = new Audio(src)
      a.loop = t.loop; a.muted = mutedRef.current
      let vol = t.volume
      if (scene?.id) {
        try {
          const saved = JSON.parse(localStorage.getItem(`sf_vol_${scene.id}`) || '{}')
          if (typeof saved[t.id] === 'number') vol = saved[t.id]
        } catch {}
      }
      a.volume = vol
      const playHandler  = () => setPlaying(p => ({ ...p, [t.id]: true  }))
      const pauseHandler = () => setPlaying(p => ({ ...p, [t.id]: false }))
      a.addEventListener('play',  playHandler)
      a.addEventListener('pause', pauseHandler)
      audioHandlers.current[t.id] = { play: playHandler, pause: pauseHandler }
      audioRefs.current[t.id] = a
      setVolumes(v => ({ ...v, [t.id]: vol }))
    }
    return audioRefs.current[t.id]
  }

  function toggleTrack(t: Track) {
    if (t.spotify_uri) { spotify.toggle(t); return }
    const a = getOrCreate(t)
    if (a.paused) { a.play().catch(() => {}) } else { a.pause() }
  }
  function setVol(t: Track, val: number) {
    if (t.spotify_uri) { spotify.setVolume(t, val); return }
    const a = getOrCreate(t)
    a.volume = val
    setVolumes(v => ({ ...v, [t.id]: val }))
    if (scene?.id) {
      try {
        const key = `sf_vol_${scene.id}`
        const saved = JSON.parse(localStorage.getItem(key) || '{}')
        saved[t.id] = val
        localStorage.setItem(key, JSON.stringify(saved))
      } catch {}
    }
  }
  function stopAll() {
    Object.values(audioRefs.current).forEach(a => { a.pause(); a.currentTime = 0 })
    Object.values(sfxAudioRef.current).forEach(({ audio }) => { try { audio.pause(); audio.src = '' } catch {} })
    sfxAudioRef.current = {}
    spotify.stopAll()
  }
  function toggleMute() {
    const next = !muted; setMuted(next)
    Object.values(audioRefs.current).forEach(a => (a.muted = next))
    Object.values(sfxAudioRef.current).forEach(({ audio }) => (audio.muted = next))
    spotify.mute(next)
  }

  function trackPlaying(t: Track) { return t.spotify_uri ? (spotify.states[t.id]?.playing ?? false) : (playing[t.id] ?? false) }
  function trackVolume(t: Track)  { return t.spotify_uri ? (spotify.states[t.id]?.volume  ?? t.volume) : (volumes[t.id] ?? t.volume) }

  // ── Scene change → swap tracks ──────────────────────────────────
  useEffect(() => {
    // Save outgoing scene's volumes so they restore correctly on revisit.
    if (prevSceneIdForVolRef.current && Object.keys(audioRefs.current).length > 0) {
      const savedVols: Record<string, number> = {}
      Object.entries(audioRefs.current).forEach(([id, a]) => {
        savedVols[id] = volumes[id] ?? a.volume
      })
      try { localStorage.setItem(`sf_vol_${prevSceneIdForVolRef.current}`, JSON.stringify(savedVols)) } catch {}
    }
    prevSceneIdForVolRef.current = scene?.id ?? null

    if (Object.keys(audioRefs.current).length > 0) {
      disposeRefs(audioRefs.current, audioHandlers.current)
    }
    audioRefs.current = {}; audioHandlers.current = {}; setVolumes({}); setPlaying({})

    if (!scene?.tracks?.length) return
    // Music (kind==='music') is a playlist — only one plays at a time.
    // Layers (ml2/ml3) and ambience always play simultaneously.
    const musicTracks  = scene.tracks.filter(t => t.kind === 'music' && !t.spotify_uri)
    const alwaysOn     = scene.tracks.filter(t => (t.kind === 'ml2' || t.kind === 'ml3' || t.kind === 'ambience') && !t.spotify_uri)
    const startId      = activeMusicTrackIdRef.current
    const musicToStart = (startId ? musicTracks.find(t => t.id === startId) : null) ?? musicTracks[0]
    const tracksToPlay = [...(musicToStart ? [musicToStart] : []), ...alwaysOn]
    // Just attempt — modern browsers allow autoplay after high-engagement
    // origin status, and the audio mixer's manual play buttons are a user
    // gesture for browsers that block. Silent failure beats a blocking modal.
    tracksToPlay.forEach(t => {
      const a = getOrCreate(t)
      if (a.paused) a.play().catch(() => {})
    })
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Switch music track when DM changes it ─────────────────────
  useEffect(() => {
    if (!activeMusicTrackId || !scene) return
    const allMusic = (scene.tracks || []).filter(t => t.kind === 'music')
    const targetTrack = allMusic.find(t => t.id === activeMusicTrackId)
    if (!targetTrack) return

    allMusic.forEach(t => {
      if (!t.spotify_uri && t.id !== activeMusicTrackId) {
        const a = audioRefs.current[t.id]
        if (a && !a.paused) { a.pause(); a.currentTime = 0 }
      }
    })

    if (targetTrack.spotify_uri) {
      // stopAll() resets activeTrackRef inside the hook so toggle always calls playTrack
      spotify.stopAll()
      spotify.toggle(targetTrack)
    } else {
      const a = getOrCreate(targetTrack)
      a.volume = volumes[targetTrack.id] ?? a.volume
      if (a.paused) a.play().catch(() => {})
    }
  }, [activeMusicTrackId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load scene ────────────────────────────────────────────────
  const loadScene = useCallback(async (sceneId: string | null, sessionOverlays?: Record<string, OverlayLiveState> | null) => {
    if (!sceneId) { setScene(null); return }
    const { data } = await supabase.from('scenes').select('*, tracks(*), handouts(*), scene_overlays(*)').eq('id', sceneId).single()
    if (data) {
      const scene = { ...(data as any), overlays: (data as any).scene_overlays ?? [] } as Scene
      setScene(scene)
      setStatus('live')
      // Build live overlay state: use DM's session state if provided, else scene defaults
      const overlayInit: Record<string, OverlayLiveState> = {}
      for (const o of scene.overlays ?? []) {
        const fromSession = sessionOverlays?.[o.id]
        overlayInit[o.id] = fromSession ?? { on: o.enabled_default, opacity: o.opacity }
      }
      setActiveOverlays(overlayInit)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load session ──────────────────────────────────────────────
  // Idempotent: safe to call repeatedly (initial mount, visibility resume,
  // periodic resync). Skips the expensive scene reload when active_scene_id
  // hasn't changed so a resync doesn't churn audio refs / overlay state.
  const loadSession = useCallback(async () => {
    const { data } = await supabase.from('sessions')
      .select('id, campaign_id, active_scene_id, is_live, character_state, active_handout_id, active_music_track_id, active_overlays, active_sfx_event')
      .eq('join_code', joinCode).maybeSingle()
    if (!data)         { setStatus('waiting'); return }
    if (!data.is_live) { setStatus('ended');   return }
    const sessionOverlays = (data.active_overlays ?? {}) as Record<string, OverlayLiveState>
    const sceneChanged = data.active_scene_id !== sceneRef.current?.id
    if (sceneChanged) {
      await loadScene(data.active_scene_id, sessionOverlays)
    } else if (data.active_overlays) {
      setActiveOverlays(data.active_overlays as Record<string, OverlayLiveState>)
    }
    await loadCharactersFromState(data.character_state as CharacterState | null)
    setActiveHandoutId(data.active_handout_id ?? null)
    setActiveMusicTrackId(data.active_music_track_id ?? null)
    // Soundboard + Library: fetch campaign-scoped data so SFX events resolve
    // and the library button has its handouts ready. Only on first load /
    // campaign change — the per-campaign realtime subscriptions below keep
    // these in sync afterward, so the live-resync poll skips this work.
    if (data.campaign_id && data.campaign_id !== sessionCampaignIdRef.current) {
      sessionCampaignIdRef.current = data.campaign_id
      setSessionCampaignId(data.campaign_id)
      const [{ data: sounds }, { data: handouts }] = await Promise.all([
        supabase.from('campaign_sounds').select('*').eq('campaign_id', data.campaign_id).order('order_index'),
        supabase.from('handouts').select('*').eq('campaign_id', data.campaign_id).order('order_index'),
      ])
      if (sounds)   setCampaignSounds(sounds as CampaignSound[])
      if (handouts) setCampaignHandouts(handouts as Handout[])
    }
    // Mark any pre-existing SFX event as already-handled so we don't replay
    // it on reload.
    const ev = data.active_sfx_event as SfxEvent | null
    lastSfxEventIdRef.current = ev?.id ?? null
  }, [joinCode, loadScene, loadCharactersFromState])

  useEffect(() => { loadSession() }, [loadSession])

  useEffect(() => {
    if (status !== 'waiting') return
    const t = setInterval(loadSession, 6000)
    return () => clearInterval(t)
  }, [status, loadSession])

  // Recover from a silently-dropped Realtime channel. When the tab goes
  // background the websocket can stop receiving postgres_changes events;
  // resuming the tab or coming back online doesn't always replay the missed
  // updates. Re-fetch session state on visibility/online so the viewer
  // catches up without a full reload. This deliberately does NOT touch the
  // channel subscription (touching it churns the SDK — see #99 revert).
  // Stable deps via useCallback singleton supabase keep this from re-binding.
  useEffect(() => {
    function onResume() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      loadSession()
    }
    function onOnline() { loadSession() }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('online', onOnline)
    }
  }, [loadSession])

  // Belt-and-suspenders resync while live. The Realtime channel can silently
  // stall while the tab is foregrounded (server-side disconnect, transient
  // network blip the SDK doesn't surface). loadSession is now idempotent —
  // it skips the scene reload + character fetch when nothing changed — so a
  // 15s poll catches DM scene switches the channel missed without disrupting
  // playback when state is steady.
  useEffect(() => {
    if (status !== 'live') return
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      loadSession()
    }, 15000)
    return () => clearInterval(t)
  }, [status, loadSession])

  // ── Realtime: session updates ─────────────────────────────────
  useEffect(() => {
    const ch = supabase.channel('viewer-' + joinCode)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sessions',
        filter: `join_code=eq.${joinCode}`,
      }, (payload) => {
        const row = payload.new as { active_scene_id: string | null; is_live: boolean; character_state: CharacterState | null; active_handout_id: string | null; active_music_track_id: string | null; active_overlays: Record<string, OverlayLiveState> | null; active_sfx_event: SfxEvent | null }
        if (!row.is_live) { setStatus('ended'); return }
        const sceneChanging = row.active_scene_id !== sceneRef.current?.id
        if (sceneChanging) {
          loadScene(row.active_scene_id, row.active_overlays ?? undefined)
        } else {
          // Same scene — apply overlay live state directly without a reload
          if (row.active_overlays) setActiveOverlays(row.active_overlays)
          // If DM just pushed an ID we don't have locally (added mid-session),
          // re-fetch the full scene so the new track/handout is available before we try to use it.
          const handoutMissing = row.active_handout_id && !(sceneRef.current?.handouts ?? []).some(h => h.id === row.active_handout_id)
          const trackMissing   = row.active_music_track_id && !(sceneRef.current?.tracks ?? []).some(t => t.id === row.active_music_track_id)
          if (handoutMissing || trackMissing) loadScene(row.active_scene_id)
        }
        loadCharactersFromState(row.character_state)
        setActiveHandoutId(row.active_handout_id ?? null)
        setActiveMusicTrackId(row.active_music_track_id ?? null)
        // SFX: only react to genuinely new events (id differs from last seen)
        const ev = row.active_sfx_event
        if (ev && ev.id !== lastSfxEventIdRef.current) {
          lastSfxEventIdRef.current = ev.id
          playSfxEvent(ev, campaignSoundsRef.current)
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [joinCode, loadScene, loadCharactersFromState, playSfxEvent])

  // Realtime: campaign_sounds inserts/updates/deletes so newly added sounds
  // are immediately available without a session reload.
  useEffect(() => {
    if (!sessionCampaignId) return
    const ch = supabase.channel('viewer-sounds-' + sessionCampaignId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_sounds', filter: `campaign_id=eq.${sessionCampaignId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const s = payload.new as CampaignSound
            setCampaignSounds(prev => prev.some(x => x.id === s.id) ? prev : [...prev, s])
          } else if (payload.eventType === 'UPDATE') {
            const s = payload.new as CampaignSound
            setCampaignSounds(prev => prev.map(x => x.id === s.id ? s : x))
          } else if (payload.eventType === 'DELETE') {
            const id = (payload.old as { id: string }).id
            setCampaignSounds(prev => prev.filter(x => x.id !== id))
          }
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [sessionCampaignId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: campaign-scoped handouts so library updates appear without a
  // page reload. Filter on campaign_id so scene handouts (campaign_id=null)
  // never match.
  useEffect(() => {
    if (!sessionCampaignId) return
    const ch = supabase.channel('viewer-library-' + sessionCampaignId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'handouts', filter: `campaign_id=eq.${sessionCampaignId}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const h = payload.new as Handout
            setCampaignHandouts(prev => prev.some(x => x.id === h.id) ? prev : [...prev, h])
          } else if (payload.eventType === 'UPDATE') {
            const h = payload.new as Handout
            setCampaignHandouts(prev => prev.map(x => x.id === h.id ? h : x))
          } else if (payload.eventType === 'DELETE') {
            const id = (payload.old as { id: string }).id
            setCampaignHandouts(prev => prev.filter(x => x.id !== id))
            setLibraryHandout(curr => curr?.id === id ? null : curr)
          }
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [sessionCampaignId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: track inserts/updates/deletes for active scene ──
  useEffect(() => {
    if (!scene?.id) return
    const ch = supabase.channel('viewer-tracks-' + scene.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tracks', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const t = payload.new as Track
          setScene(prev => prev ? { ...prev, tracks: [...(prev.tracks ?? []).filter(x => x.id !== t.id), t] } : prev)
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tracks', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const t = payload.new as Track
          setScene(prev => prev ? { ...prev, tracks: (prev.tracks ?? []).map(x => x.id === t.id ? t : x) } : prev)
        })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tracks', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const id = (payload.old as { id: string }).id
          setScene(prev => prev ? { ...prev, tracks: (prev.tracks ?? []).filter(x => x.id !== id) } : prev)
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: active scene's own UPDATEs (name, hide_title, bg, location) ──
  // The session-row subscription already triggers a full re-fetch when
  // active_scene_id changes. This handles in-place edits of the *current*
  // scene's metadata so toggles like hide_title flip live.
  useEffect(() => {
    if (!scene?.id) return
    const ch = supabase.channel('viewer-scene-' + scene.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scenes', filter: `id=eq.${scene.id}` },
        (payload) => {
          const next = payload.new as Partial<Scene>
          setScene(prev => prev ? { ...prev, ...next } : prev)
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime: handout inserts/updates/deletes for active scene ──
  useEffect(() => {
    if (!scene?.id) return
    const ch = supabase.channel('viewer-handouts-' + scene.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'handouts', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const h = payload.new as Handout
          setScene(prev => prev ? { ...prev, handouts: [...(prev.handouts ?? []).filter(x => x.id !== h.id), h] } : prev)
        })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'handouts', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const h = payload.new as Handout
          setScene(prev => prev ? { ...prev, handouts: (prev.handouts ?? []).map(x => x.id === h.id ? h : x) } : prev)
        })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'handouts', filter: `scene_id=eq.${scene.id}` },
        (payload) => {
          const id = (payload.old as { id: string }).id
          setScene(prev => prev ? { ...prev, handouts: (prev.handouts ?? []).filter(x => x.id !== id) } : prev)
        })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scene crossfade (two stable layers) ─────────────────────
  interface VBgLayer { scene: Scene | null; opacity: number }
  const [vLayerA, setVLayerA] = useState<VBgLayer>({ scene: null, opacity: 0 })
  const [vLayerB, setVLayerB] = useState<VBgLayer>({ scene: null, opacity: 0 })
  const vFrontRef      = useRef<'a' | 'b'>('a')
  const vPrevSceneId   = useRef<string | null>(null)

  if (scene?.id !== vPrevSceneId.current) {
    vPrevSceneId.current = scene?.id ?? null
    if (scene) {
      if (vFrontRef.current === 'a') {
        setVLayerB({ scene, opacity: 1 })
        setVLayerA(prev => ({ ...prev, opacity: 0 }))
        vFrontRef.current = 'b'
      } else {
        setVLayerA({ scene, opacity: 1 })
        setVLayerB(prev => ({ ...prev, opacity: 0 }))
        vFrontRef.current = 'a'
      }
    }
  }

  const allTracks    = scene?.tracks || []
  const baseMusic    = allTracks.filter(t => t.kind === 'music')
  const layers       = allTracks.filter(t => t.kind === 'ml2' || t.kind === 'ml3')
  const amb          = allTracks.filter(t => t.kind === 'ambience')
  // Current music track: DM's selection → first playing → first track
  const currentMusicTrack = (
    (activeMusicTrackId ? baseMusic.find(t => t.id === activeMusicTrackId) : null) ??
    baseMusic.find(t => trackPlaying(t)) ??
    baseMusic[0] ??
    null
  )
  const currentMusicIdx = currentMusicTrack ? baseMusic.indexOf(currentMusicTrack) : 0
  const hasSpotifyTracks = allTracks.some(t => !!t.spotify_uri)
  const spotifyPlayingCount = Object.values(spotify.states).filter(s => s.playing).length
  const playingCount = Object.values(playing).filter(Boolean).length + spotifyPlayingCount

  // ── Status screens ────────────────────────────────────────────
  if (status === 'loading') return (
    <div style={fsStyle}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: '22px', color: '#c9a84c', letterSpacing: '2px', marginBottom: '14px' }}>Reverie</div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '2px' }}>Connecting…</div>
      </div>
    </div>
  )

  if (status === 'waiting') return (
    <div style={fsStyle}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ marginBottom: '18px' }}><AppIcon size={48} opacity={0.25} /></div>
        <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: '13px', color: 'rgba(255,255,255,0.5)', letterSpacing: '4px', textTransform: 'uppercase', marginBottom: '10px' }}>Waiting for DM</div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.2)', letterSpacing: '1px' }}>Session code: {joinCode}</div>
        <div style={{ marginTop: '10px', display: 'flex', gap: '5px', justifyContent: 'center' }}>
          {[0,1,2].map(i => <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c9a84c', animation: `dot .8s ease-in-out ${i*.2}s infinite alternate`, opacity: .4 }} />)}
        </div>
      </div>
      <style>{`@keyframes dot{from{opacity:.2;transform:scale(.8)}to{opacity:1;transform:scale(1.1)}}`}</style>
    </div>
  )

  if (status === 'ended') return (
    <div style={fsStyle}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '42px', marginBottom: '18px', opacity: .2 }}>⚔️</div>
        <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: '13px', color: 'rgba(255,255,255,0.4)', letterSpacing: '4px', textTransform: 'uppercase' }}>Session Ended</div>
      </div>
    </div>
  )

  // ── Live viewer ───────────────────────────────────────────────
  return (
    <div ref={wrapperRef} style={{ ...fsStyle, overflow: 'hidden', isolation: 'isolate' }}>

      {/* Background layer A — isolation:isolate prevents Android Chrome's GPU-
          composited video layer from breaking above UI siblings in z-index. */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0, opacity: vLayerA.opacity, transition: 'opacity 1s ease', pointerEvents: 'none', isolation: 'isolate' }}>
        {vLayerA.scene && (() => {
          const lBg = pubUrl(vLayerA.scene.bg)
          return (<>
            {lBg && (vLayerA.scene.bg?.type === 'video'
              ? <video key={lBg} src={lBg} autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <img   key={lBg} src={lBg} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {lBg && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.55) 100%)' }} />}
          </>)
        })()}
      </div>

      {/* Background layer B */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0, opacity: vLayerB.opacity, transition: 'opacity 1s ease', pointerEvents: 'none', isolation: 'isolate' }}>
        {vLayerB.scene && (() => {
          const lBg = pubUrl(vLayerB.scene.bg)
          return (<>
            {lBg && (vLayerB.scene.bg?.type === 'video'
              ? <video key={lBg} src={lBg} autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <img   key={lBg} src={lBg} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {lBg && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.55) 100%)' }} />}
          </>)
        })()}
      </div>

      {/* ── Characters (below overlay — atmosphere washes over them) ── */}
      {(['left', 'center', 'right'] as const).map(slot => {
        const char = characters[slot]
        if (!char) return null
        if (viewerDisplay[slot].aboveOverlay) return null
        return (
          <CharacterDisplay
            key={slot}
            character={char}
            position={slot}
            imageUrl={characterImageUrl(char)}
            scale={viewerScales[slot]}
            imgZoom={viewerDisplay[slot].zoom}
            imgPanX={viewerDisplay[slot].panX}
            imgPanY={viewerDisplay[slot].panY}
            flipped={viewerDisplay[slot].flipped}
          />
        )
      })}

      {/* ── Overlay stack — renders between the two character layers. ── */}
      {(scene?.overlays?.length ?? 0) > 0 && (
        <OverlayStack overlays={scene!.overlays!} liveStates={activeOverlays} />
      )}

      {/* ── Characters (above overlay — punch through atmospheric FX) ── */}
      {(['left', 'center', 'right'] as const).map(slot => {
        const char = characters[slot]
        if (!char) return null
        if (!viewerDisplay[slot].aboveOverlay) return null
        return (
          <CharacterDisplay
            key={slot}
            character={char}
            position={slot}
            imageUrl={characterImageUrl(char)}
            scale={viewerScales[slot]}
            imgZoom={viewerDisplay[slot].zoom}
            imgPanX={viewerDisplay[slot].panX}
            imgPanY={viewerDisplay[slot].panY}
            flipped={viewerDisplay[slot].flipped}
          />
        )
      })}

      {/* Scene name */}
      {scene && !scene.hide_title && (
        <div key={scene.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, textAlign: 'center', padding: 'calc(18px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right)) 18px calc(18px + env(safe-area-inset-left))', fontFamily: "'Cormorant Garamond',serif", fontSize: '16px', letterSpacing: '6px', fontWeight: 500, color: 'rgba(255,255,255,.8)', textShadow: '0 1px 16px rgba(0,0,0,.9)', pointerEvents: 'none', zIndex: 5, animation: 'sceneFadeIn 1s ease forwards' }}>
          {scene.name}
        </div>
      )}

      {!scene && (
        <div style={{ zIndex: 1, textAlign: 'center', color: 'rgba(255,255,255,0.2)', position: 'relative' }}>
          <div style={{ marginBottom: '12px' }}><AppIcon size={48} opacity={0.2} /></div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '3px' }}>Awaiting Scene</div>
        </div>
      )}

      {/* Fullscreen + Library — opposite corner from mixer */}
      <div style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', [mixerPos === 'top-left' ? 'right' : 'left']: `calc(14px + env(safe-area-inset-${mixerPos === 'top-left' ? 'right' : 'left'}))`, zIndex: 20, display: 'flex', flexDirection: 'column', alignItems: mixerPos === 'top-left' ? 'flex-end' : 'flex-start', gap: '8px', maxWidth: 'calc(100vw - 28px - var(--stage-mixer-w) - 16px)' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: mixerPos === 'top-left' ? 'flex-end' : 'flex-start' }}>
          {campaignHandouts.length > 0 && (
            <button
              onClick={() => setLibraryOpen(o => !o)}
              title="Campaign Library"
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: `1px solid ${libraryOpen ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.12)'}`, background: libraryOpen ? 'rgba(201,168,76,0.12)' : MIXER_BG, color: libraryOpen ? 'var(--accent)' : 'rgba(255,255,255,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.5 3.2c0-.3.2-.5.5-.5h3.6c.6 0 1.1.5 1.1 1.1v9.5c0-.6-.5-1.1-1.1-1.1H3c-.3 0-.5-.2-.5-.5V3.2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                <path d="M12.5 3.2c0-.3-.2-.5-.5-.5H8.4c-.6 0-1.1.5-1.1 1.1v9.5c0-.6.5-1.1 1.1-1.1H12c.3 0 .5-.2.5-.5V3.2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {supportsFullscreen && (
            <button onClick={toggleFs} style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.12)', background: MIXER_BG, color: 'rgba(255,255,255,0.6)', fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isFs ? '✕' : '⛶'}
            </button>
          )}
        </div>

        {libraryOpen && campaignHandouts.length > 0 && (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ width: '260px', background: MIXER_BG_PANEL, border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>Library</span>
              <button onClick={() => setLibraryOpen(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>
            <div style={{ maxHeight: '320px', overflowY: 'auto', padding: '6px 8px' }}>
              {campaignHandouts.map(h => {
                const imgUrl = pubUrl(h.media)
                return (
                  <button
                    key={h.id}
                    onClick={() => { setLibraryHandout(h); setLibraryOpen(false) }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: '6px', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ width: '40px', height: '40px', borderRadius: 'var(--r-sm)', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {imgUrl
                        ? <img src={imgUrl} alt={h.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span style={{ fontSize: '16px', opacity: 0.5 }}>📖</span>
                      }
                    </div>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Spotify connect/reconnect prompt — when scene has Spotify tracks but
          the SDK isn't ready. Shows "Connect" for first-time auth and
          "Reconnect" (calls player.connect() — no full re-auth) once we've
          had a valid session that dropped. lastError surfaces the SDK's own
          message so disconnects aren't silent. */}
      {hasSpotifyTracks && !spotify.connected && (
        <div style={{ position: 'absolute', bottom: 'calc(20px + env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)', zIndex: 30, background: MIXER_BG, border: '1px solid rgba(30,215,96,0.3)', borderRadius: '10px', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 'calc(100vw - 40px)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#1ed760"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" /></svg>
          {spotify.unsupported ? (
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', textAlign: 'center' }}>
              Spotify playback isn’t supported on iPhone or iPad. Open this link in Chrome or Safari on a desktop to hear streaming tracks.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                {spotify.lastError ? 'Spotify disconnected' : 'This scene has Spotify music'}
              </span>
              {spotify.lastError && (
                <span style={{ fontSize: '10px', color: 'rgba(255,85,85,0.7)', maxWidth: '320px', textAlign: 'center' }}>{spotify.lastError}</span>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => spotify.reconnect()} style={{ fontSize: '11px', fontWeight: 700, color: '#1ed760', background: 'transparent', border: '1px solid rgba(30,215,96,0.5)', borderRadius: 'var(--r-sm)', padding: '4px 10px', cursor: 'pointer' }}>Reconnect</button>
                <a href="/auth/spotify" style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.6)', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 'var(--r-sm)', padding: '4px 10px' }}>Re-auth</a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Handout lightbox — shown when DM pushes a handout ── */}
      {activeHandout && (() => {
        const resolvedMedia = activeHandout.media
          ? { ...activeHandout.media, signed_url: pubUrl(activeHandout.media as any) || activeHandout.media.url }
          : null
        return <HandoutLightbox handout={{ ...activeHandout, media: resolvedMedia }} onClose={() => setActiveHandoutId(null)} />
      })()}

      {/* ── Library lightbox — viewer-pulled, independent of DM ── */}
      {libraryHandout && (() => {
        const resolvedMedia = libraryHandout.media
          ? { ...libraryHandout.media, signed_url: pubUrl(libraryHandout.media as any) || libraryHandout.media.url }
          : null
        return <HandoutLightbox handout={{ ...libraryHandout, media: resolvedMedia }} onClose={() => setLibraryHandout(null)} />
      })()}

      {/* Audio Mixer */}
      {allTracks.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', [mixerPos === 'top-left' ? 'left' : 'right']: `calc(14px + env(safe-area-inset-${mixerPos === 'top-left' ? 'left' : 'right'}))`, zIndex: 20, width: 'var(--stage-mixer-w)' }}>
          <div onClick={() => setMixerOpen(o => !o)} style={{ background: MIXER_BG, border: '1px solid rgba(255,255,255,0.14)', borderRadius: mixerOpen ? '10px 10px 0 0' : '10px', height: '44px', padding: '0 10px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '16px', flexShrink: 0 }}>
              {[1,0.6,0.85,0.45,0.7].map((h,i) => <div key={i} style={{ width: '3px', borderRadius: '1px', background: playingCount > 0 ? '#c9a84c' : 'rgba(255,255,255,0.2)', height: `${Math.round(h*16)}px`, animation: playingCount > 0 ? `audioBar${i} ${0.6+i*0.15}s ease-in-out infinite alternate` : 'none' }} />)}
            </div>
            <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', flex: 1, minWidth: 0 }}>Audio</span>
            {playingCount > 0 && <span style={{ fontSize: '10px', color: '#c9a84c', fontWeight: 700, flexShrink: 0 }}>{playingCount}</span>}
            <button
              onClick={e => {
                e.stopPropagation()
                const next = mixerPos === 'top-left' ? 'top-right' : 'top-left'
                setMixerPos(next)
                localStorage.setItem('sf_mixer_pos', next)
              }}
              title={mixerPos === 'top-left' ? 'Move to top right' : 'Move to top left'}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: '13px', cursor: 'pointer', padding: '0 2px', flexShrink: 0, lineHeight: 1, display: 'flex', alignItems: 'center' }}
            >
              {mixerPos === 'top-left' ? '▷' : '◁'}
            </button>
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{mixerOpen ? '▲' : '▼'}</span>
          </div>
          {mixerOpen && (
            <div style={{ background: MIXER_BG_PANEL, border: '1px solid rgba(255,255,255,0.14)', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
              {/* ── Base music — playlist style: only current track shown ── */}
              {baseMusic.length > 0 && (
                <div style={{ padding: '10px 14px 6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', flex: 1 }}>🎵 Music</span>
                    {baseMusic.length > 1 && (
                      <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', minWidth: '28px', textAlign: 'right' }}>{currentMusicIdx + 1}/{baseMusic.length}</span>
                    )}
                  </div>
                  {currentMusicTrack && (
                    <TrackRow key={currentMusicTrack.id} t={currentMusicTrack} isPlaying={trackPlaying(currentMusicTrack)} volume={trackVolume(currentMusicTrack)} onToggle={() => toggleTrack(currentMusicTrack)} onVol={v => setVol(currentMusicTrack, v)} nowPlaying={currentMusicTrack.spotify_uri && trackPlaying(currentMusicTrack) ? spotify.nowPlaying : null} progress={currentMusicTrack.spotify_uri && trackPlaying(currentMusicTrack) ? spotify.progress : undefined} onSkip={currentMusicTrack.spotify_uri ? d => spotify.skip(d) : undefined} />
                  )}
                </div>
              )}
              {/* ── Dynamic layers ── */}
              {layers.length > 0 && (
                <>
                  {baseMusic.length > 0 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0 14px' }} />}
                  <div style={{ padding: '10px 14px 6px' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '8px' }}>🎚 Layers</div>
                    {layers.map(t => <TrackRow key={t.id} t={t} isPlaying={trackPlaying(t)} volume={trackVolume(t)} onToggle={() => toggleTrack(t)} onVol={v => setVol(t, v)} nowPlaying={t.spotify_uri && trackPlaying(t) ? spotify.nowPlaying : null} progress={t.spotify_uri && trackPlaying(t) ? spotify.progress : undefined} onSkip={t.spotify_uri ? d => spotify.skip(d) : undefined} />)}
                  </div>
                </>
              )}
              {(baseMusic.length > 0 || layers.length > 0) && amb.length > 0 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0 14px' }} />}
              {amb.length > 0 && (
                <div style={{ padding: '10px 14px 6px' }}>
                  <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '8px' }}>🌊 Ambience</div>
                  {amb.map(t => <TrackRow key={t.id} t={t} isPlaying={trackPlaying(t)} volume={trackVolume(t)} onToggle={() => toggleTrack(t)} onVol={v => setVol(t, v)} nowPlaying={t.spotify_uri && trackPlaying(t) ? spotify.nowPlaying : null} progress={t.spotify_uri && trackPlaying(t) ? spotify.progress : undefined} onSkip={t.spotify_uri ? d => spotify.skip(d) : undefined} />)}
                </div>
              )}
              <div style={{ padding: '8px 14px 10px', display: 'flex', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <button onClick={e => { e.stopPropagation(); stopAll() }} style={{ flex: 1, height: '44px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.6)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>⏹ Stop All</button>
                <button onClick={e => { e.stopPropagation(); toggleMute() }} style={{ width: '44px', height: '44px', background: muted ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.06)', border: `1px solid ${muted ? '#c9a84c' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', color: muted ? '#c9a84c' : 'rgba(255,255,255,0.6)', fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {muted ? '🔇' : '🔊'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes audioBar0{from{height:4px}to{height:16px}}
        @keyframes audioBar1{from{height:8px}to{height:5px}}
        @keyframes audioBar2{from{height:13px}to{height:6px}}
        @keyframes audioBar3{from{height:5px}to{height:14px}}
        @keyframes audioBar4{from{height:11px}to{height:4px}}
        @keyframes sceneFadeIn{from{opacity:0}to{opacity:1}}
      `}</style>
    </div>
  )
}

const fsStyle: React.CSSProperties = {
  width: '100dvw', height: '100dvh', background: '#070810',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  position: 'relative',
}

interface TrackRowProps {
  t:          Track
  isPlaying:  boolean
  volume:     number
  onToggle:   () => void
  onVol:      (v: number) => void
  nowPlaying?: SpotifyNowPlaying | null
  progress?:  number
  onSkip?:    (direction: 'next' | 'previous') => void
}

function TrackRow({ t, isPlaying, volume, onToggle, onVol, nowPlaying, progress, onSkip }: TrackRowProps) {
  const isSpotify    = !!t.spotify_uri
  const showMeta     = isSpotify && isPlaying && !!nowPlaying
  const showProgress = isSpotify && isPlaying && typeof progress === 'number'
  const showSkip     = isSpotify && isPlaying && !!onSkip && t.spotify_type === 'playlist'

  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {showMeta && nowPlaying?.albumArt && (
          <img src={nowPlaying.albumArt} alt="" width={36} height={36} style={{ borderRadius: '4px', flexShrink: 0, objectFit: 'cover' }} />
        )}
        <button onClick={e => { e.stopPropagation(); onToggle() }} style={{ width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0, border: `1px solid ${isPlaying ? '#c9a84c' : 'rgba(255,255,255,0.15)'}`, background: isPlaying ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.05)', color: isPlaying ? '#c9a84c' : 'rgba(255,255,255,0.5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.65)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: showMeta ? '2px' : '6px' }}>
            {showMeta ? nowPlaying!.name : t.name}
          </div>
          {showMeta && (
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '4px' }}>
              {nowPlaying!.artist}
            </div>
          )}
          <input type="range" min={0} max={1} step={0.01} value={volume} onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); onVol(Number(e.target.value)) }} style={{ width: '100%', height: '20px', accentColor: '#c9a84c', cursor: 'pointer', touchAction: 'none' }} />
        </div>
      </div>
      {showProgress && (
        <div style={{ marginTop: '6px', height: '2px', background: 'rgba(255,255,255,0.1)', borderRadius: '1px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(progress ?? 0) * 100}%`, background: '#1ed760', borderRadius: '1px', transition: 'width 0.5s linear' }} />
        </div>
      )}
      {showSkip && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px', justifyContent: 'center' }}>
          <button onClick={e => { e.stopPropagation(); onSkip!('previous') }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', fontSize: '13px', height: '32px', padding: '0 14px', cursor: 'pointer' }}>⏮</button>
          <button onClick={e => { e.stopPropagation(); onSkip!('next')     }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', fontSize: '13px', height: '32px', padding: '0 14px', cursor: 'pointer' }}>⏭</button>
        </div>
      )}
    </div>
  )
}
