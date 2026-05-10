'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { Scene, Track, Character, Handout, SceneOverlay, OverlayLiveState, CampaignSound } from '@/lib/types'
import { uploadMedia, deleteMedia, publicStorageUrl } from '@/lib/supabase/storage'
import { createClient } from '@/lib/supabase/client'
import CharacterDisplay from '@/components/CharacterDisplay'
import { mediaUrl, characterImageUrl } from '@/lib/media'
import AppIcon from '@/components/AppIcon'
import HandoutLightbox from '@/components/HandoutLightbox'
import OverlayStack from '@/components/OverlayStack'
import UploadZone from '@/components/UploadZone'
import type { SpotifyPlayerApi } from '@/lib/useSpotifyPlayer'
import { isIosWebkit } from '@/lib/platform'
import { crossfadeAudio, type FadeHandle } from '@/lib/audioFade'

interface ActiveCharacters {
  left:   Character | null
  center: Character | null
  right:  Character | null
}

interface SlotScales {
  left:   number
  center: number
  right:  number
}

interface SlotDisplay {
  zoom?:         number   // 1.0 – 3.0
  panX?:         number   // 0–100
  panY?:         number   // 0–100
  flipped?:      boolean
  aboveOverlay?: boolean  // when true, character renders in front of OverlayStack
}

interface SlotDisplayProps {
  left:   SlotDisplay
  center: SlotDisplay
  right:  SlotDisplay
}

interface Props {
  scene:              Scene | null
  hasCampaign:        boolean
  onEdit:             () => void
  // Spotify player owned by the parent (page.tsx) so it survives navigation
  // between the home view and the campaign view without disconnecting.
  spotify:            SpotifyPlayerApi
  // Character props (DM only — undefined on viewer)
  characters?:        ActiveCharacters
  slotScales?:        SlotScales
  slotDisplayProps?:  SlotDisplayProps
  campaignCharacters?: Character[]
  onCharactersChange?: (c: ActiveCharacters) => void
  onSlotDisplayChange?: (slot: 'left'|'center'|'right', scale: number, display: SlotDisplay) => void
  onSaveSlotDisplay?: (slot: 'left'|'center'|'right') => Promise<void>
  onHandoutShow?: (handoutId: string | null) => void
  onMusicTrackChange?: (trackId: string | null) => void
  /**
   * sessions.active_music_track_id mirrored from the page. During live the
   * mixer's "current track" derives from this rather than the local
   * musicIdx — needed because (a) musicIdx resets to 0 on every scene
   * change, but the viewer's actual track is whatever the session row says,
   * and (b) cross-tab DM sessions need a shared source of truth.
   */
  activeMusicTrackId?: string | null
  isLive?: boolean
  // Overlay props (DM only — undefined on viewer)
  activeOverlays?: Record<string, OverlayLiveState>
  onOverlayStateChange?: (id: string, state: OverlayLiveState) => void
  // Soundboard (DM only — undefined on viewer)
  sounds?: CampaignSound[]
  campaignId?: string
  userId?: string
  onSoundsChange?: (next: CampaignSound[]) => void
  onPlaySfx?: (sound: CampaignSound) => void
  onStopSfx?: (soundId: string) => void
  // Campaign-level library handouts (DM only — undefined on viewer)
  campaignHandouts?: Handout[]
  onCampaignHandoutsChange?: (next: Handout[]) => void
}

const SFX_DEFAULT_VOL    = 1

const DEFAULT_CHAR_DISPLAY: SlotDisplay = { zoom: 1, panX: 50, panY: 100, flipped: false, aboveOverlay: false }

interface BgLayer { scene: Scene | null; opacity: number }

const MIXER_BG       = 'rgba(13,14,22,0.96)'
const MIXER_BG_PANEL = 'rgba(18,20,30,0.98)'

export default function Stage({
  scene, hasCampaign, onEdit, spotify,
  characters, slotScales, slotDisplayProps, campaignCharacters,
  onCharactersChange, onSlotDisplayChange, onSaveSlotDisplay, onHandoutShow, onMusicTrackChange, activeMusicTrackId, isLive,
  activeOverlays, onOverlayStateChange,
  sounds, campaignId, userId, onSoundsChange, onPlaySfx, onStopSfx,
  campaignHandouts, onCampaignHandoutsChange,
}: Props) {
  const supabase = createClient()
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ── Scene crossfade (two stable layers) ─────────────────────
  // Two always-mounted bg divs (A and B) swap opacity via CSS transition.
  // The inactive layer (opacity 0) receives the new scene content; because
  // it's invisible the video remount is undetectable. No key changes on the
  // layer wrappers means running videos are never interrupted.
  const [layerA, setLayerA] = useState<BgLayer>(() => ({ scene: scene ?? null, opacity: scene ? 1 : 0 }))
  const [layerB, setLayerB] = useState<BgLayer>(() => ({ scene: null, opacity: 0 }))
  const frontLayerRef  = useRef<'a' | 'b'>('a')
  const prevSceneIdRef = useRef<string | null>(scene?.id ?? null)
  const prevSceneRef   = useRef<Scene | null>(scene ?? null)

  // Derived-state swap: runs during render so both layers commit together.
  if (scene?.id !== prevSceneIdRef.current) {
    // Scene ID changed — full crossfade to the new scene.
    prevSceneIdRef.current = scene?.id ?? null
    prevSceneRef.current   = scene ?? null
    if (scene) {
      if (frontLayerRef.current === 'a') {
        setLayerB({ scene, opacity: 1 })
        setLayerA(prev => ({ ...prev, opacity: 0 }))
        frontLayerRef.current = 'b'
      } else {
        setLayerA({ scene, opacity: 1 })
        setLayerB(prev => ({ ...prev, opacity: 0 }))
        frontLayerRef.current = 'a'
      }
    }
  } else if (scene && scene !== prevSceneRef.current) {
    // Same scene ID but the scene object was replaced (e.g. after editing and
    // saving the scene). Update the front layer's scene reference in-place so
    // the background and track list reflect the new content without a crossfade.
    prevSceneRef.current = scene
    if (frontLayerRef.current === 'a') {
      setLayerA(prev => ({ ...prev, scene }))
    } else {
      setLayerB(prev => ({ ...prev, scene }))
    }
  }

  // ── Audio ────────────────────────────────────────────────────
  type Handlers = { play: () => void; pause: () => void; ended?: () => void }
  const audioRefs              = useRef<Record<string, HTMLAudioElement>>({})
  const audioHandlers          = useRef<Record<string, Handlers>>({})
  // Tracks the in-flight DM-side music crossfade so a rapid second switch
  // cancels the first instead of stacking ramps.
  const musicFadeRef           = useRef<FadeHandle | null>(null)
  const [volumes, setVolumes]  = useState<Record<string, number>>({})
  const [playing, setPlaying]  = useState<Record<string, boolean>>({})
  const [muted,   setMuted]    = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [mixerPos, setMixerPos] = useState<'top-left' | 'top-right'>('top-left')
  useEffect(() => {
    const saved = localStorage.getItem('sf_mixer_pos') as 'top-left' | 'top-right' | null
    if (saved) setMixerPos(saved)
  }, [])
  const prevSceneIdForVolRef = useRef<string | null>(null)
  // Playlist: tracks the currently active base-music track index
  const [musicIdx, setMusicIdx] = useState(0)
  const musicIdxRef            = useRef(0)
  const sceneMusicRef          = useRef<Track[]>([])
  // Stable refs so the endedHandler closure (created once when the audio
  // element is built) always reads the latest props/state instead of the
  // values captured at element-creation time.
  const onMusicTrackChangeRef  = useRef(onMusicTrackChange)
  useEffect(() => { onMusicTrackChangeRef.current = onMusicTrackChange }, [onMusicTrackChange])
  const spotifyRef             = useRef(spotify)
  useEffect(() => { spotifyRef.current = spotify })
  const volumesRef             = useRef(volumes)
  useEffect(() => { volumesRef.current = volumes }, [volumes])

  // Detach listeners + pause + clear src on a refs map
  const disposeRefs = useCallback((refs: Record<string, HTMLAudioElement>, handlers: Record<string, Handlers>) => {
    Object.entries(refs).forEach(([id, a]) => {
      const h = handlers[id]
      if (h) {
        a.removeEventListener('play',  h.play)
        a.removeEventListener('pause', h.pause)
        if (h.ended) a.removeEventListener('ended', h.ended)
      }
      a.pause(); a.src = ''
    })
  }, [])

  // ── Handouts ─────────────────────────────────────────────────
  const [handoutsOpen,   setHandoutsOpen]   = useState(false)
  const [activeHandout,  setActiveHandout]  = useState<Handout | null>(null)

  // ── Campaign Library (campaign-scoped handouts) ──────────────
  // Separate from scene handouts: opening a library handout shows it locally
  // on the DM screen only and never writes to active_handout_id, so viewers
  // are unaffected. Viewers have their own library button and pull these
  // independently.
  const [libraryOpen,     setLibraryOpen]     = useState(false)
  const [libraryHandout,  setLibraryHandout]  = useState<Handout | null>(null)
  const [libAddOpen,      setLibAddOpen]      = useState(false)
  const [libAddName,      setLibAddName]      = useState('')
  const [libAddFile,      setLibAddFile]      = useState<File | null>(null)
  const [libAddUrl,       setLibAddUrl]       = useState('')
  const [libAddSaving,    setLibAddSaving]    = useState(false)

  // ── Overlays panel ───────────────────────────────────────────
  const [overlaysOpen, setOverlaysOpen] = useState(false)

  // ── Soundboard panel ─────────────────────────────────────────
  const [soundboardOpen, setSoundboardOpen] = useState(false)
  const [sbUploading,    setSbUploading]    = useState(false)
  const [sbRecentlyPlayed, setSbRecentlyPlayed] = useState<Record<string, number>>({})
  // Right-click quick-edit popover anchored at cursor position
  const [sbQuickEdit, setSbQuickEdit] = useState<{ soundId: string; x: number; y: number } | null>(null)
  // True between the first "Delete" click in the quick-edit popover and the
  // confirm click (or auto-cancel ~4s later). Cleared whenever the popover
  // closes or moves to a different sound.
  const [sbDeleteArmed, setSbDeleteArmed] = useState(false)
  const sbDeleteArmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Timestamp the popover was opened. Used by the backdrop to ignore the
  // trailing pointerup/click from the long-press gesture that opened it —
  // without this, on touch devices the popover dismisses immediately because
  // the user's finger is still down when it appears.
  const sbQuickEditOpenedAtRef = useRef(0)
  const sbFileInputRef   = useRef<HTMLInputElement>(null)
  // Concurrent SFX playbacks — keyed by a unique playback id. Each entry
  // tags the soundId so we can find + stop all in-flight playbacks for a
  // given sound (e.g. when the DM taps the pad a second time).
  const sfxAudioRef      = useRef<Record<string, { audio: HTMLAudioElement; soundId: string }>>({})
  // Counts of active playbacks per sound id — drives the pad "playing" UI.
  // Only used for state-driven re-render; the ref above is the source of truth.
  const [sfxActiveCounts, setSfxActiveCounts] = useState<Record<string, number>>({})

  const playSfxLocal = useCallback((sound: CampaignSound) => {
    const src = sound.signed_url
      || (sound.storage_path ? publicStorageUrl(sound.storage_path) : null)
      || sound.url
    if (!src) return
    const a = new Audio(src)
    a.muted = muted
    a.volume = sound.volume ?? SFX_DEFAULT_VOL
    const playbackId = `${sound.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sfxAudioRef.current[playbackId] = { audio: a, soundId: sound.id }
    setSfxActiveCounts(p => ({ ...p, [sound.id]: (p[sound.id] || 0) + 1 }))
    const cleanup = () => {
      if (!sfxAudioRef.current[playbackId]) return
      delete sfxAudioRef.current[playbackId]
      a.removeEventListener('ended', cleanup)
      a.removeEventListener('error', cleanup)
      setSfxActiveCounts(p => {
        const next = { ...p }
        const v = (next[sound.id] || 1) - 1
        if (v <= 0) delete next[sound.id]
        else next[sound.id] = v
        return next
      })
    }
    a.addEventListener('ended', cleanup)
    a.addEventListener('error', cleanup)
    a.play().catch(() => cleanup())
    setSbRecentlyPlayed(prev => ({ ...prev, [sound.id]: Date.now() }))
  }, [muted])

  // Stop every in-flight playback for this sound.
  const stopSfxLocal = useCallback((soundId: string) => {
    Object.entries(sfxAudioRef.current).forEach(([key, { audio, soundId: sid }]) => {
      if (sid !== soundId) return
      try { audio.pause(); audio.src = '' } catch {}
      delete sfxAudioRef.current[key]
    })
    setSfxActiveCounts(p => {
      if (!(soundId in p)) return p
      const next = { ...p }; delete next[soundId]; return next
    })
  }, [])

  // Tap-toggle: if any playback for this sound is in flight, stop it; otherwise play.
  const playSfx = useCallback((sound: CampaignSound) => {
    const isPlaying = Object.values(sfxAudioRef.current).some(x => x.soundId === sound.id)
    if (isPlaying) {
      stopSfxLocal(sound.id)
      onStopSfx?.(sound.id)
    } else {
      playSfxLocal(sound)
      onPlaySfx?.(sound)
    }
  }, [playSfxLocal, stopSfxLocal, onPlaySfx, onStopSfx])

  function openQuickEdit(soundId: string, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    openQuickEditAt(soundId, e.clientX, e.clientY)
  }

  function openQuickEditAt(soundId: string, x: number, y: number) {
    const popW = 280, popH = 130, margin = 12
    // On touch the user's finger covers the cursor point; nudge the popover
    // up so it appears above the finger when there's room.
    const adjustedY = y - popH - 16 >= margin ? y - popH - 16 : y + 16
    const cx = Math.max(margin, Math.min(x - popW / 2, window.innerWidth - popW - margin))
    const cy = Math.max(margin, Math.min(adjustedY, window.innerHeight - popH - margin))
    sbQuickEditOpenedAtRef.current = Date.now()
    setSbQuickEdit({ soundId, x: cx, y: cy })
  }

  // ── Pad long-press (touch / pen) → quick edit ────────────────
  // Mouse uses onContextMenu (right-click). Touch/pen uses a 500ms hold,
  // cancelled if the pointer moves >10px or releases early.
  const padLongPressedRef = useRef(false)
  const padTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)
  const padStartPosRef    = useRef<{ x: number; y: number } | null>(null)

  function handlePadPointerDown(soundId: string, e: React.PointerEvent) {
    if (e.pointerType === 'mouse') return
    padLongPressedRef.current = false
    const x = e.clientX, y = e.clientY
    padStartPosRef.current = { x, y }
    if (padTimerRef.current) clearTimeout(padTimerRef.current)
    padTimerRef.current = setTimeout(() => {
      padTimerRef.current = null
      padLongPressedRef.current = true
      openQuickEditAt(soundId, x, y)
    }, 500)
  }

  function handlePadPointerMove(e: React.PointerEvent) {
    if (!padStartPosRef.current || !padTimerRef.current) return
    const dx = e.clientX - padStartPosRef.current.x
    const dy = e.clientY - padStartPosRef.current.y
    if (dx * dx + dy * dy > 100) {
      clearTimeout(padTimerRef.current)
      padTimerRef.current = null
    }
  }

  function handlePadPointerUp() {
    if (padTimerRef.current) { clearTimeout(padTimerRef.current); padTimerRef.current = null }
    padStartPosRef.current = null
  }

  function handlePadClick(s: CampaignSound) {
    if (padLongPressedRef.current) {
      padLongPressedRef.current = false
      return
    }
    playSfx(s)
  }

  // Esc / outside click dismiss for the quick-edit popover
  useEffect(() => {
    if (!sbQuickEdit) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setSbQuickEdit(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sbQuickEdit])

  // Closing the soundboard panel should also dismiss any open popover.
  // Otherwise it hovers in the void with no anchor visible.
  useEffect(() => {
    if (!soundboardOpen) setSbQuickEdit(null)
  }, [soundboardOpen])

  // Reset the delete-armed state whenever the popover closes or jumps to a
  // different sound, and clear the auto-cancel timer on unmount.
  useEffect(() => {
    setSbDeleteArmed(false)
    if (sbDeleteArmedTimerRef.current) {
      clearTimeout(sbDeleteArmedTimerRef.current)
      sbDeleteArmedTimerRef.current = null
    }
  }, [sbQuickEdit?.soundId])
  useEffect(() => () => {
    if (sbDeleteArmedTimerRef.current) clearTimeout(sbDeleteArmedTimerRef.current)
  }, [])

  function showHandout(h: Handout | null) {
    setActiveHandout(h)
    onHandoutShow?.(h?.id ?? null)
  }

  // ── Fullscreen ───────────────────────────────────────────────
  const [isFullscreen, setIsFullscreen] = useState(false)
  // iOS Safari (and all iOS browsers, since they're WebKit shells) doesn't
  // implement the Fullscreen API. Hide the button entirely instead of leaving
  // a dead control on screen — users on iPad should "Add to Home Screen" or
  // hide Safari's toolbar via the aA menu for a fullscreen-like experience.
  const supportsFullscreen = !isIosWebkit()

  const enterFullscreen = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    if (el.requestFullscreen) el.requestFullscreen()
    else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen()
  }, [])

  const exitFullscreen = useCallback(() => {
    if (document.exitFullscreen) document.exitFullscreen()
    else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen()
  }, [])

  useEffect(() => {
    function onChange() {
      setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement))
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  // ── Character slot panel state (DM only) ─────────────────────
  // activeSlot: which slot's panel is open; panelMode: adjust existing or pick new
  const [activeSlot,    setActiveSlot]    = useState<'left' | 'center' | 'right' | null>(null)
  const [panelMode,     setPanelMode]     = useState<'adjust' | 'pick'>('pick')
  const [savedConfirm,  setSavedConfirm]  = useState(false)
  const savedConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (savedConfirmTimerRef.current) clearTimeout(savedConfirmTimerRef.current) }, [])
  const [charSearch, setCharSearch]   = useState('')
  // Track whether this device has touch so we can disable autoFocus (which
  // opens the keyboard on Android and resizes the stage, hiding the popup).
  const isTouchDevice = useRef(false)
  useEffect(() => {
    isTouchDevice.current = navigator.maxTouchPoints > 0
  }, [])
  // Timestamp of when the picker was last opened. Used to guard the
  // click-away overlay against closing the picker within the same touch
  // gesture that opened it (Android synthesizes a click after touchend even
  // when preventDefault is called in some WebView versions).
  const pickerOpenTimeRef = useRef(0)

  // Close panels whenever the scene changes.
  useEffect(() => {
    setActiveSlot(null)
    setCharSearch('')
    setHandoutsOpen(false)
    setOverlaysOpen(false)
    showHandout(null)
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredChars = useMemo(
    () => (campaignCharacters || []).filter(c =>
      !charSearch || c.name.toLowerCase().includes(charSearch.toLowerCase())
    ),
    [campaignCharacters, charSearch],
  )

  function pickCharacter(c: Character) {
    if (!activeSlot || !onCharactersChange || !characters) return
    onCharactersChange({ ...characters, [activeSlot]: c })
    // After picking, switch to adjust mode so DM can fine-tune immediately.
    setPanelMode('adjust')
    setCharSearch('')
  }

  function removeCharacter(slot: 'left' | 'center' | 'right') {
    if (!onCharactersChange || !characters) return
    onCharactersChange({ ...characters, [slot]: null })
    if (activeSlot === slot) setActiveSlot(null)
  }

  // Keep refs in sync for stable event-handler callbacks
  useEffect(() => { musicIdxRef.current = musicIdx }, [musicIdx])

  // ── Audio: scene change → swap tracks ────────────────────────
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

    // Any in-flight track-switch crossfade points at audio elements we're
    // about to dispose — cancel before tearing them down.
    musicFadeRef.current?.cancel()
    musicFadeRef.current = null
    if (Object.keys(audioRefs.current).length > 0) {
      disposeRefs(audioRefs.current, audioHandlers.current)
    }
    audioRefs.current = {}
    audioHandlers.current = {}
    setVolumes({})
    setPlaying({})

    // Reset music playlist index
    setMusicIdx(0)
    musicIdxRef.current = 0

    if (!scene?.tracks?.length) return

    const baseMusic = scene.tracks.filter(t => t.kind === 'music' && !t.spotify_uri)
    const layers    = scene.tracks.filter(t => (t.kind === 'ml2' || t.kind === 'ml3') && !t.spotify_uri)
    const amb       = scene.tracks.filter(t => t.kind === 'ambience' && !t.spotify_uri)
    sceneMusicRef.current = scene.tracks.filter(t => t.kind === 'music')

    // Viewer is the sole audio master during live presentation. Don't
    // start any DM audio on scene change — the going-live effect would
    // pause it again immediately, and pre-creating the audio elements
    // means the next non-live scene change has stale refs to dispose.
    if (!isLive) {
      baseMusic.forEach((t, i) => {
        const a = getOrCreate(t)
        if (i === 0 && (t.signed_url || t.url)) a.play().catch(() => {})
      })
      layers.forEach(t => {
        if (t.signed_url || t.url) getOrCreate(t).play().catch(() => {})
      })
      amb.forEach(t => {
        if (t.signed_url || t.url) getOrCreate(t).play().catch(() => {})
      })
    } else {
      // Live: viewer is the audio master, DM stays silent. Still preload all
      // music tracks so when the DM exits live mode and starts switching
      // tracks locally the crossfade has buffered audio to work with.
      baseMusic.forEach(t => { if (t.signed_url || t.url) getOrCreate(t) })
    }
  }, [scene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Silence the DM the moment the presentation goes live — the viewer is the
  // sole audio master while presenting (Spotify especially: both DM + viewer
  // share one playback context, so any DM playback fights the viewer for the
  // active device). Resume ambience when the presentation stops; leave music
  // and layers paused so the DM can choose what to bring back manually.
  useEffect(() => {
    if (!isLive) {
      // Going not-live: resume any ambience that was running before.
      // Only touch elements that already exist in audioRefs — new-scene
      // autoplay is handled by the scene-change effect so we don't double-start on mount.
      const ambTracks = (scene?.tracks || []).filter(t => t.kind === 'ambience' && !t.spotify_uri)
      ambTracks.forEach(t => {
        const a = audioRefs.current[t.id]
        if (a && a.paused) a.play().catch(() => {})
      })
      return
    }
    // Going live: pause every file track (music, layers, ambience).
    musicFadeRef.current?.cancel()
    musicFadeRef.current = null
    Object.values(audioRefs.current).forEach(a => {
      if (!a.paused) { a.pause(); a.currentTime = 0 }
    })
    // Stop Spotify — disableAutoPlay only blocks new auto-starts; existing
    // playback keeps going on the DM device unless we tell it to stop.
    spotify.stopAll()
    // Force-sync mixer UI immediately — DOM 'pause' events fire async.
    setPlaying(p => {
      const next: Record<string, boolean> = {}
      Object.keys(p).forEach(id => { next[id] = false })
      return next
    })
  }, [isLive]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stop all audio when Stage unmounts (e.g. navigating back to campaign home)
  useEffect(() => {
    return () => {
      musicFadeRef.current?.cancel()
      musicFadeRef.current = null
      disposeRefs(audioRefs.current, audioHandlers.current)
      audioRefs.current   = {}
      audioHandlers.current = {}
      Object.values(sfxAudioRef.current).forEach(({ audio }) => { try { audio.pause(); audio.src = '' } catch {} })
      sfxAudioRef.current = {}
      // Cancel pending volume save debouncers and the long-press timer.
      Object.values(sbVolumeTimersRef.current).forEach(t => clearTimeout(t))
      sbVolumeTimersRef.current = {}
      if (padTimerRef.current) { clearTimeout(padTimerRef.current); padTimerRef.current = null }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function getOrCreate(t: Track): HTMLAudioElement {
    if (t.spotify_uri) return new Audio() // never used — Spotify tracks go through SDK
    if (!audioRefs.current[t.id]) {
      // preload + explicit load() to actually buffer the file. See viewer's
      // getOrCreate for the rationale: preload alone is just a hint browsers
      // can ignore, and the default load level ('metadata') doesn't actually
      // pre-download. Setting preload before src and calling load() forces it.
      const a = new Audio()
      a.preload = 'auto'
      a.src = t.signed_url || t.url || ''
      a.load()
      a.loop = t.loop; a.muted = muted
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

      // Base music tracks auto-advance to next when they end (loop tracks
      // never fire `ended`, so this is multi-track-only by construction).
      // The previous version did a hard play() without crossfade and skipped
      // Spotify next-tracks entirely (it had `if (!next.spotify_uri)` and
      // never called the SDK), so a [file → spotify] playlist would advance
      // the index but produce silence. We fix both with crossfadeAudio +
      // spotify.fadeTo, depending on the kind of next track.
      let endedHandler: (() => void) | undefined
      if (t.kind === 'music') {
        endedHandler = () => {
          const tracks = sceneMusicRef.current
          if (tracks.length <= 1) return
          const nextIdx = (musicIdxRef.current + 1) % tracks.length
          const next = tracks[nextIdx]
          if (next) {
            if (next.spotify_uri) {
              spotifyRef.current.fadeTo(next).catch(() => {})
            } else {
              const nextAudio = audioRefs.current[next.id]
              if (nextAudio) {
                const nextVol = volumesRef.current[next.id] ?? nextAudio.volume
                // The just-ended audio is already paused at duration end —
                // crossfadeAudio's fade-out is effectively instant, but the
                // fade-in on the new track stays smooth.
                musicFadeRef.current?.cancel()
                musicFadeRef.current = crossfadeAudio(a, nextAudio, nextVol)
              }
            }
          }
          setMusicIdx(nextIdx)
          musicIdxRef.current = nextIdx
          onMusicTrackChangeRef.current?.(next?.id ?? null)
        }
        a.addEventListener('ended', endedHandler)
      }

      audioHandlers.current[t.id] = { play: playHandler, pause: pauseHandler, ended: endedHandler }
      audioRefs.current[t.id] = a
      setVolumes(v => ({ ...v, [t.id]: vol }))
    }
    return audioRefs.current[t.id]
  }

  function toggleTrack(t: Track) {
    // During live, the viewer is the sole audio master. Local playback on
    // the DM stage would conflict — and for Spotify it actively steals the
    // playback device from the viewer. The mixer's music row doubles as a
    // "switch viewer's active track" control via onMusicTrackChange; layers
    // and ambience have no per-track live channel, so the click is a no-op.
    if (isLive) {
      if (t.kind === 'music') onMusicTrackChange?.(t.id)
      return
    }
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
    musicFadeRef.current?.cancel()
    musicFadeRef.current = null
    Object.values(audioRefs.current).forEach(a => { a.pause(); a.currentTime = 0 })
    Object.values(sfxAudioRef.current).forEach(({ audio }) => { try { audio.pause(); audio.src = '' } catch {} })
    sfxAudioRef.current = {}
    setSfxActiveCounts({})
    spotify.stopAll()
  }
  function handleMute() {
    const next = !muted; setMuted(next)
    Object.values(audioRefs.current).forEach(a => (a.muted = next))
    Object.values(sfxAudioRef.current).forEach(({ audio }) => (audio.muted = next))
    spotify.mute(next)
  }

  // ── Soundboard CRUD ─────────────────────────────────────────
  async function handleSbUpload(file: File) {
    if (!campaignId || !userId || !onSoundsChange) return
    setSbUploading(true)
    try {
      const path = await uploadMedia(supabase, userId, file)
      const name = file.name.replace(/\.[^.]+$/, '')
      const next_order = (sounds?.length ?? 0)
      const { data, error } = await supabase.from('campaign_sounds')
        .insert({
          campaign_id: campaignId,
          name,
          storage_path: path,
          file_name: file.name,
          volume: SFX_DEFAULT_VOL,
          order_index: next_order,
        })
        .select()
        .single()
      if (error) throw error
      const newSound = { ...data, signed_url: publicStorageUrl(path) } as CampaignSound
      onSoundsChange([...(sounds ?? []), newSound])
    } catch (e) {
      console.error('SFX upload failed:', e)
    } finally {
      setSbUploading(false)
    }
  }

  async function handleSbRename(s: CampaignSound, name: string) {
    if (!onSoundsChange) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === s.name) return
    onSoundsChange((sounds ?? []).map(x => x.id === s.id ? { ...x, name: trimmed } : x))
    const { error } = await supabase.from('campaign_sounds').update({ name: trimmed }).eq('id', s.id)
    if (error) console.error('[soundboard] rename failed:', error)
  }

  // Debounce per-sound volume writes — slider drags fire onChange ~60×/sec.
  const sbVolumeTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  function handleSbVolume(s: CampaignSound, vol: number) {
    if (!onSoundsChange) return
    const v = Math.max(0, Math.min(1, vol))
    onSoundsChange((sounds ?? []).map(x => x.id === s.id ? { ...x, volume: v } : x))
    // Live-update any in-flight playback of this sound so dragging the slider
    // changes loudness immediately during preview.
    Object.values(sfxAudioRef.current).forEach(({ audio, soundId }) => {
      if (soundId === s.id) audio.volume = v
    })
    const existing = sbVolumeTimersRef.current[s.id]
    if (existing) clearTimeout(existing)
    sbVolumeTimersRef.current[s.id] = setTimeout(async () => {
      delete sbVolumeTimersRef.current[s.id]
      const { error } = await supabase.from('campaign_sounds').update({ volume: v }).eq('id', s.id)
      if (error) console.error('[soundboard] volume save failed:', error)
    }, 200)
  }

  async function handleSbDelete(s: CampaignSound) {
    if (!onSoundsChange) return
    onSoundsChange((sounds ?? []).filter(x => x.id !== s.id))
    const { error } = await supabase.from('campaign_sounds').delete().eq('id', s.id)
    if (error) console.error('[soundboard] delete failed:', error)
    if (s.storage_path) {
      try { await deleteMedia(supabase, s.storage_path) } catch (e) {
        console.error('[soundboard] storage delete failed:', e)
      }
    }
  }

  // ── Campaign Library CRUD ───────────────────────────────────
  function libAddReset() {
    setLibAddOpen(false); setLibAddName(''); setLibAddFile(null); setLibAddUrl('')
  }

  async function handleLibAdd() {
    if (!campaignId || !userId || !onCampaignHandoutsChange) return
    const name = libAddName.trim()
    if (!name || (!libAddFile && !libAddUrl.trim())) return
    setLibAddSaving(true)
    try {
      let media: { type: 'image'; url?: string; storage_path?: string; file_name?: string } | null = null
      if (libAddFile) {
        const path = await uploadMedia(supabase, userId, libAddFile)
        media = { type: 'image', storage_path: path, file_name: libAddFile.name }
      } else if (libAddUrl.trim()) {
        media = { type: 'image', url: libAddUrl.trim() }
      }
      const next_order = campaignHandouts?.length ?? 0
      const { data, error } = await supabase.from('handouts')
        .insert({ campaign_id: campaignId, scene_id: null, name, media, order_index: next_order })
        .select()
        .single()
      if (error) throw error
      const inserted = data as Handout
      const stamped = inserted.media?.storage_path
        ? { ...inserted, media: { ...inserted.media, signed_url: publicStorageUrl(inserted.media.storage_path) } }
        : inserted
      onCampaignHandoutsChange([...(campaignHandouts ?? []), stamped])
      libAddReset()
    } catch (e) {
      console.error('[library] add failed:', e)
    } finally {
      setLibAddSaving(false)
    }
  }

  async function handleLibRemove(h: Handout) {
    if (!onCampaignHandoutsChange) return
    onCampaignHandoutsChange((campaignHandouts ?? []).filter(x => x.id !== h.id))
    if (libraryHandout?.id === h.id) setLibraryHandout(null)
    const { error } = await supabase.from('handouts').delete().eq('id', h.id)
    if (error) console.error('[library] delete failed:', error)
    if (h.media?.storage_path) {
      try { await deleteMedia(supabase, h.media.storage_path) } catch (e) {
        console.error('[library] storage delete failed:', e)
      }
    }
  }

  function switchMusicTrack(newIdx: number) {
    const baseTracks = (scene?.tracks || []).filter(t => t.kind === 'music')
    if (newIdx < 0 || newIdx >= baseTracks.length) return
    // During live, the source-of-truth current index comes from
    // active_music_track_id (mirrored via prop). Comparing against local
    // musicIdx for the no-op check would let stale Tab B clicks bail
    // incorrectly when Tab A had already advanced. For not-live we keep
    // musicIdx as the index since there's no session row to anchor to.
    const liveIdx = isLive && activeMusicTrackId
      ? baseTracks.findIndex(t => t.id === activeMusicTrackId)
      : -1
    const fromIdx = liveIdx >= 0 ? liveIdx : musicIdx
    if (newIdx === fromIdx) return
    const current = baseTracks[fromIdx]
    const next    = baseTracks[newIdx]
    // During live, the viewer drives playback. We just push the track ID and
    // skip every local play/pause — going live already silenced the DM, and
    // local play would re-steal the Spotify device from the viewer.
    if (!isLive) {
      // Cancel any in-flight crossfade so a rapid second switch doesn't stack
      // ramps on the same elements.
      musicFadeRef.current?.cancel()
      musicFadeRef.current = null

      const fileToFile = current && next && !current.spotify_uri && !next.spotify_uri
      if (fileToFile) {
        const fromAudio = audioRefs.current[current.id] ?? null
        const toAudio   = getOrCreate(next)
        const toVol     = volumes[next.id] ?? toAudio.volume
        musicFadeRef.current = crossfadeAudio(fromAudio, toAudio, toVol)
      } else {
        // Mixed file/Spotify or one-sided — fade out the outgoing source and
        // fade in the incoming one independently.
        if (current) {
          if (!current.spotify_uri) {
            const a = audioRefs.current[current.id]
            if (a) musicFadeRef.current = crossfadeAudio(a, null, 0)
          } else if (spotify.states[current.id]?.playing) {
            spotify.fadeOut().catch(() => {})
          }
        }
        if (next) {
          if (!next.spotify_uri) {
            const toAudio = getOrCreate(next)
            const toVol   = volumes[next.id] ?? toAudio.volume
            musicFadeRef.current = crossfadeAudio(null, toAudio, toVol)
          } else if (!spotify.states[next.id]?.playing) {
            spotify.fadeTo(next).catch(() => {})
          }
        }
      }
    }
    setMusicIdx(newIdx)
    musicIdxRef.current = newIdx
    onMusicTrackChange?.(next?.id ?? null)
  }

  if (!scene) {
    return (
      <div style={{ flex: 1, background: '#080a10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
          <div style={{ marginBottom: '14px' }}><AppIcon size={48} opacity={0.2} /></div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2.5px' }}>
            {hasCampaign ? 'Select a Scene' : 'Select a Campaign'}
          </div>
        </div>
      </div>
    )
  }

  const bgUrl        = mediaUrl(scene.bg)
  const sceneOverlays = scene.overlays || []
  const liveOverlays  = activeOverlays ?? {}
  const activeOverlayCount = sceneOverlays.filter(o => {
    const s = liveOverlays[o.id]
    return s ? s.on : o.enabled_default
  }).length
  const allTracks    = scene.tracks || []
  const baseMusic    = allTracks.filter(t => t.kind === 'music')
  const layers       = allTracks.filter(t => t.kind === 'ml2' || t.kind === 'ml3')
  const amb          = allTracks.filter(t => t.kind === 'ambience')
  const handouts     = scene.handouts || []
  const hasTracks    = allTracks.length > 0
  // Keep sceneMusicRef in sync with the current scene's music list so the
  // onended closure always advances to the correct next track
  sceneMusicRef.current = baseMusic
  // During live, the source of truth for the current track is the session
  // row (active_music_track_id) — it survives scene changes, multi-tab
  // setups, and viewer-side auto-advance. The local musicIdx still drives
  // not-live preview where there's no session to anchor to. If the session
  // hasn't picked one yet (active_music_track_id is null right after a
  // scene change), fall back to baseMusic[0] since that's what the viewer
  // auto-plays in `useEffect` on scene load.
  const liveActiveIdx       = isLive && activeMusicTrackId
    ? baseMusic.findIndex(t => t.id === activeMusicTrackId)
    : -1
  const liveFallbackIdx     = isLive && baseMusic.length > 0 ? 0 : -1
  const effectiveMusicIdx   = liveActiveIdx >= 0
    ? liveActiveIdx
    : (liveFallbackIdx >= 0 ? liveFallbackIdx : Math.min(musicIdx, Math.max(0, baseMusic.length - 1)))
  const clampedMusicIdx     = effectiveMusicIdx
  const currentMusicTrack   = baseMusic[clampedMusicIdx] ?? null
  const spotifyPlayingCount = Object.values(spotify.states).filter(s => s.playing).length
  const playingCount = Object.values(playing).filter(Boolean).length + spotifyPlayingCount

  // Helpers to read merged state for any track
  function trackPlaying(t: Track) { return t.spotify_uri ? (spotify.states[t.id]?.playing ?? false) : (playing[t.id] ?? false) }
  function trackVolume(t: Track)  { return t.spotify_uri ? (spotify.states[t.id]?.volume  ?? t.volume) : (volumes[t.id] ?? t.volume) }
  function trackLoop(t: Track)    { return t.spotify_uri ? (spotify.states[t.id]?.loop    ?? t.loop)   : t.loop }
  const hasDMControls = !!onCharactersChange

  return (
    <div
      ref={wrapperRef}
      style={{
        // When fullscreen, flex:1 loses its meaning (the parent flex container
        // is no longer in play). Android Chrome doesn't resolve flex-based
        // height for the fullscreen element's containing block, so absolute
        // children with height:'88%' collapse to 0. Use explicit viewport
        // dimensions instead so position:absolute children size correctly.
        flex: isFullscreen ? undefined : 1,
        width:  isFullscreen ? '100dvw' : undefined,
        height: isFullscreen ? '100dvh' : undefined,
        position: 'relative',
        overflow: 'hidden',
        background: '#080a10',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Required so OverlayStack's mix-blend-mode reads the bg layers as
        // its backdrop. Without this, the blend escapes upward through the
        // app's stacking contexts and ends up blending against the page bg
        // (or nothing, depending on ancestor z-index), producing a black
        // wash instead of the scene + screen-blended fog.
        isolation: 'isolate',
      }}
    >
      {/* ── Background layer A — isolation:isolate prevents Android Chrome's
          GPU-composited video layer from breaking above UI siblings. ── */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0, opacity: layerA.opacity, transition: 'opacity 1s ease', pointerEvents: 'none', isolation: 'isolate' }}>
        {layerA.scene && (() => {
          const lBg = mediaUrl(layerA.scene.bg)
          return (<>
            {lBg && (layerA.scene.bg?.type === 'video'
              ? <video key={lBg} src={lBg} autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <img   key={lBg} src={lBg} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {lBg && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.55) 100%)' }} />}
          </>)
        })()}
      </div>

      {/* ── Background layer B ── */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0, opacity: layerB.opacity, transition: 'opacity 1s ease', pointerEvents: 'none', isolation: 'isolate' }}>
        {layerB.scene && (() => {
          const lBg = mediaUrl(layerB.scene.bg)
          return (<>
            {lBg && (layerB.scene.bg?.type === 'video'
              ? <video key={lBg} src={lBg} autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <img   key={lBg} src={lBg} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            )}
            {lBg && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.55) 100%)' }} />}
          </>)
        })()}
      </div>

      {/* ── Characters (below overlay — atmosphere washes over them) ── */}
      {(['left', 'center', 'right'] as const).map(slot => {
        const char = characters?.[slot]
        if (!char) return null
        if (slotDisplayProps?.[slot].aboveOverlay) return null
        return (
          <CharacterDisplay
            key={slot}
            character={char}
            position={slot}
            imageUrl={characterImageUrl(char)}
            scale={slotScales?.[slot] ?? 1}
            imgZoom={slotDisplayProps?.[slot].zoom}
            imgPanX={slotDisplayProps?.[slot].panX}
            imgPanY={slotDisplayProps?.[slot].panY}
            flipped={slotDisplayProps?.[slot].flipped}
          />
        )
      })}

      {/* ── Overlay stack — renders between the two character layers. The
          "below" group above is washed by blend modes; the "above" group
          below punches through. OverlayStack must stay z-index auto so its
          mix-blend-mode reads bg+below-characters as backdrop. ── */}
      {sceneOverlays.length > 0 && (
        <OverlayStack overlays={sceneOverlays} liveStates={liveOverlays} />
      )}

      {/* ── Characters (above overlay — punch through atmospheric FX) ── */}
      {(['left', 'center', 'right'] as const).map(slot => {
        const char = characters?.[slot]
        if (!char) return null
        if (!slotDisplayProps?.[slot].aboveOverlay) return null
        return (
          <CharacterDisplay
            key={slot}
            character={char}
            position={slot}
            imageUrl={characterImageUrl(char)}
            scale={slotScales?.[slot] ?? 1}
            imgZoom={slotDisplayProps?.[slot].zoom}
            imgPanX={slotDisplayProps?.[slot].panX}
            imgPanY={slotDisplayProps?.[slot].panY}
            flipped={slotDisplayProps?.[slot].flipped}
          />
        )
      })}

      {/* ── Scene name ── */}
      <div key={scene.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, textAlign: 'center', padding: 'calc(14px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right)) 14px calc(14px + env(safe-area-inset-left))', fontFamily: "'Cinzel',serif", fontSize: '14px', letterSpacing: '5px', fontWeight: 500, color: 'rgba(255,255,255,.75)', textShadow: '0 1px 12px rgba(0,0,0,.9)', pointerEvents: 'none', zIndex: 5, animation: 'sceneFadeIn 1s ease forwards' }}>
        {scene.name}
      </div>

      {/* ── No background placeholder ── */}
      {!bgUrl && (
        <div style={{ zIndex: 1, textAlign: 'center', color: 'var(--text-3)', position: 'relative' }}>
          <div style={{ fontSize: '40px', opacity: .2, marginBottom: '12px' }}>🖼</div>
          <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2.5px', marginBottom: '14px' }}>No Background</div>
          <button className="btn btn-outline" onClick={onEdit}>Edit Scene</button>
        </div>
      )}

      {/* ── Top corner: Edit + Handouts + Fullscreen (opposite corner from mixer) ── */}
      <div style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', [mixerPos === 'top-left' ? 'right' : 'left']: `calc(14px + env(safe-area-inset-${mixerPos === 'top-left' ? 'right' : 'left'}))`, zIndex: 20, display: 'flex', flexDirection: 'column', alignItems: mixerPos === 'top-left' ? 'flex-end' : 'flex-start', gap: '8px', maxWidth: 'calc(100vw - 28px - var(--stage-mixer-w) - 16px)' }}>
        {/* Button row — wraps on narrow screens so the 6-icon cluster doesn't overflow into the mixer */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: mixerPos === 'top-left' ? 'flex-end' : 'flex-start' }}>
          {handouts.length > 0 && (
            <button
              onClick={() => { setHandoutsOpen(o => !o); setOverlaysOpen(false); setLibraryOpen(false); setSoundboardOpen(false) }}
              title="Handouts"
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: `1px solid ${handoutsOpen ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.14)'}`, background: handoutsOpen ? 'rgba(201,168,76,0.12)' : 'rgba(13,14,22,0.82)', color: handoutsOpen ? 'var(--accent)' : 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="1" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M4.5 5h6M4.5 7.5h6M4.5 10h3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
            </button>
          )}
          {onCampaignHandoutsChange && (
            <button
              onClick={() => { setLibraryOpen(o => !o); setHandoutsOpen(false); setOverlaysOpen(false); setSoundboardOpen(false) }}
              title="Campaign Library"
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: `1px solid ${libraryOpen ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.14)'}`, background: libraryOpen ? 'rgba(201,168,76,0.12)' : 'rgba(13,14,22,0.82)', color: libraryOpen ? 'var(--accent)' : 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.5 3.2c0-.3.2-.5.5-.5h3.6c.6 0 1.1.5 1.1 1.1v9.5c0-.6-.5-1.1-1.1-1.1H3c-.3 0-.5-.2-.5-.5V3.2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                <path d="M12.5 3.2c0-.3-.2-.5-.5-.5H8.4c-.6 0-1.1.5-1.1 1.1v9.5c0-.6.5-1.1 1.1-1.1H12c.3 0 .5-.2.5-.5V3.2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {sceneOverlays.length > 0 && onOverlayStateChange && (
            <button
              onClick={() => { setOverlaysOpen(o => !o); setHandoutsOpen(false); setLibraryOpen(false); setSoundboardOpen(false) }}
              title="Overlays"
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: `1px solid ${overlaysOpen ? 'rgba(201,168,76,0.5)' : activeOverlayCount > 0 ? 'rgba(201,168,76,0.25)' : 'rgba(255,255,255,0.14)'}`, background: overlaysOpen ? 'rgba(201,168,76,0.12)' : 'rgba(13,14,22,0.82)', color: overlaysOpen || activeOverlayCount > 0 ? 'var(--accent)' : 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <ellipse cx="7.5" cy="8" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5"/>
                <ellipse cx="7.5" cy="6" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.2" opacity="0.75"/>
                <ellipse cx="7.5" cy="4" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
              {activeOverlayCount > 0 && (
                <span style={{ position: 'absolute', top: '-4px', right: '-4px', width: '14px', height: '14px', borderRadius: '50%', background: 'var(--accent)', color: '#13151d', fontSize: '8px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{activeOverlayCount}</span>
              )}
            </button>
          )}
          {onSoundsChange && (
            <button
              onClick={() => { setSoundboardOpen(o => !o); setHandoutsOpen(false); setOverlaysOpen(false); setLibraryOpen(false) }}
              title="Soundboard"
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: `1px solid ${soundboardOpen ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.14)'}`, background: soundboardOpen ? 'rgba(201,168,76,0.12)' : 'rgba(13,14,22,0.82)', color: soundboardOpen ? 'var(--accent)' : 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="8.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="1.5" y="8.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="8.5" y="8.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </button>
          )}
          <button
            onClick={onEdit}
            title="Edit Scene"
            style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(13,14,22,0.82)', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9.5 1.5L12.5 4.5L4.5 12.5H1.5V9.5L9.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M8 3L11 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
          {supportsFullscreen && (
            <button
              onClick={isFullscreen ? exitFullscreen : enterFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              style={{ width: 'var(--stage-btn-size)', height: 'var(--stage-btn-size)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(13,14,22,0.82)', color: 'rgba(255,255,255,0.75)', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {isFullscreen ? '✕' : '⛶'}
            </button>
          )}
        </div>

        {/* Campaign Library dropdown panel — DM CRUD inline; handouts shown
            here are NOT broadcast (independent from active_handout_id). */}
        {libraryOpen && onCampaignHandoutsChange && (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ width: '280px', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>Library</span>
              <button onClick={() => setLibraryOpen(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>
            <div style={{ maxHeight: '360px', overflowY: 'auto', padding: '6px 8px' }}>
              {(campaignHandouts ?? []).map(h => {
                const imgUrl = mediaUrl(h.media)
                return (
                  <div
                    key={h.id}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 4px', borderRadius: '6px' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <button
                      onClick={() => { setLibraryHandout(h); setLibraryOpen(false) }}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', padding: '4px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <div style={{ width: '40px', height: '40px', borderRadius: 'var(--r-sm)', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {imgUrl
                          ? <img src={imgUrl} alt={h.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ fontSize: '16px', opacity: 0.5 }}>📖</span>
                        }
                      </div>
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                    </button>
                    <button
                      onClick={() => handleLibRemove(h)}
                      title="Remove"
                      style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '11px', padding: '4px 8px', flexShrink: 0 }}
                    >Remove</button>
                  </div>
                )
              })}
              {(campaignHandouts?.length ?? 0) === 0 && !libAddOpen && (
                <div style={{ padding: '20px 8px', textAlign: 'center', fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>
                  No library handouts yet.<br/>Add maps or references players can browse anytime.
                </div>
              )}
            </div>
            {/* Inline add ─────────────────────────── */}
            <div style={{ padding: '8px 10px 12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                className={`add-pill${libAddOpen ? ' active' : ''}`}
                style={{ fontSize: '10px', padding: '6px 12px' }}
                onClick={() => { libAddOpen ? libAddReset() : setLibAddOpen(true) }}
              >
                + ADD HANDOUT <span style={{ fontSize: '9px' }}>▼</span>
              </button>
              {libAddOpen && (
                <div style={{ background: 'rgba(13,14,22,0.6)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '12px', marginTop: '8px' }}>
                  <input
                    className="finput"
                    placeholder="Name (e.g. World Map, Pantheon)"
                    value={libAddName}
                    onChange={e => setLibAddName(e.target.value)}
                    style={{ fontSize: '12px', padding: '7px 10px', marginBottom: '10px', width: '100%' }}
                  />
                  <UploadZone
                    accept="image/*"
                    label="Drop image here"
                    icon="📖"
                    hint="PNG, JPG, WebP"
                    onFile={f => setLibAddFile(f)}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0', color: 'rgba(255,255,255,0.3)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.8px' }}>
                    <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />or paste a URL<div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
                  </div>
                  <input
                    className="finput"
                    placeholder="https://… image URL"
                    value={libAddUrl}
                    onChange={e => setLibAddUrl(e.target.value)}
                    style={{ fontSize: '12px', padding: '7px 10px', width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
                    <button className="btn btn-ghost btn-sm" onClick={libAddReset} disabled={libAddSaving}>Cancel</button>
                    <button
                      className="btn btn-red btn-sm"
                      disabled={libAddSaving || !libAddName.trim() || (!libAddFile && !libAddUrl.trim())}
                      onClick={handleLibAdd}
                    >
                      {libAddSaving ? 'Adding…' : 'Add Handout'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Handouts dropdown panel */}
        {handoutsOpen && handouts.length > 0 && (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ width: '260px', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>Handouts</span>
              <button onClick={() => setHandoutsOpen(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>
            <div style={{ maxHeight: '320px', overflowY: 'auto', padding: '6px 8px' }}>
              {handouts.map(h => {
                const imgUrl = mediaUrl(h.media)
                return (
                  <button
                    key={h.id}
                    onClick={() => { showHandout(h); setHandoutsOpen(false) }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: '6px', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ width: '40px', height: '40px', borderRadius: 'var(--r-sm)', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {imgUrl
                        ? <img src={imgUrl} alt={h.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span style={{ fontSize: '16px', opacity: 0.5 }}>🗺</span>
                      }
                    </div>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                    <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>Show</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Overlays dropdown panel */}
        {overlaysOpen && sceneOverlays.length > 0 && onOverlayStateChange && (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ width: '260px', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>Overlays</span>
              <button onClick={() => setOverlaysOpen(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>
            <div style={{ padding: '6px 8px 10px' }}>
              {sceneOverlays.map(o => {
                const state   = liveOverlays[o.id]
                const isOn    = state ? state.on : o.enabled_default
                const opacity = state ? state.opacity : o.opacity
                return (
                  <div key={o.id} style={{ padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: isOn ? '6px' : 0 }}>
                      <button
                        onClick={() => onOverlayStateChange(o.id, { on: !isOn, opacity })}
                        style={{ width: '28px', height: '28px', borderRadius: '6px', flexShrink: 0, border: `1px solid ${isOn ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.15)'}`, background: isOn ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.05)', color: isOn ? 'var(--accent)' : 'rgba(255,255,255,0.4)', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        {isOn ? '●' : '○'}
                      </button>
                      <span style={{ flex: 1, fontSize: '11px', color: isOn ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
                      <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', flexShrink: 0 }}>{o.blend_mode}</span>
                    </div>
                    {isOn && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '36px' }}>
                        <input
                          type="range" min={0} max={1} step={0.01} value={opacity}
                          onChange={e => onOverlayStateChange(o.id, { on: isOn, opacity: Number(e.target.value) })}
                          style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: '20px', touchAction: 'none' }}
                        />
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', width: '28px', textAlign: 'right', flexShrink: 0 }}>{Math.round(opacity * 100)}%</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Soundboard dropdown panel */}
        {soundboardOpen && onSoundsChange && (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ width: '320px', maxWidth: 'calc(100vw - 28px)', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>Soundboard</span>
              <button onClick={() => setSoundboardOpen(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>

            <input ref={sbFileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
              onChange={async e => {
                const file = e.target.files?.[0]
                if (!file) return
                e.target.value = ''
                await handleSbUpload(file)
              }}
            />

            <div style={{ padding: '12px', maxHeight: '380px', overflowY: 'auto' }}>
              {(!sounds || sounds.length === 0) && (
                <div style={{ textAlign: 'center', padding: '24px 12px', color: 'rgba(255,255,255,0.4)', fontSize: '11px' }}>
                  <div style={{ fontSize: '24px', marginBottom: '8px', opacity: 0.4 }}>🔊</div>
                  <div style={{ marginBottom: '12px' }}>No sounds yet.</div>
                  <button
                    onClick={() => sbFileInputRef.current?.click()}
                    disabled={sbUploading}
                    className="btn btn-outline btn-sm"
                  >
                    {sbUploading ? 'Uploading…' : 'Upload sound'}
                  </button>
                </div>
              )}

              {(sounds && sounds.length > 0) && (
                // Responsive grid for fast firing.
                // 4 cols on the standard 320px panel; auto-fills down to ~64px
                // pads on narrower viewports so phones get 3 columns instead.
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: '8px' }}>
                    {(sounds ?? []).map(s => {
                      const recentlyPlayed = sbRecentlyPlayed[s.id]
                      const isHot     = recentlyPlayed && Date.now() - recentlyPlayed < 600
                      const isPlaying = (sfxActiveCounts[s.id] ?? 0) > 0
                      const accent    = isPlaying || isHot
                      return (
                        <button
                          key={s.id}
                          onClick={() => handlePadClick(s)}
                          onContextMenu={e => openQuickEdit(s.id, e)}
                          onPointerDown={e => handlePadPointerDown(s.id, e)}
                          onPointerMove={handlePadPointerMove}
                          onPointerUp={handlePadPointerUp}
                          onPointerCancel={handlePadPointerUp}
                          onPointerLeave={handlePadPointerUp}
                          title={`${s.name} — ${isPlaying ? 'tap to stop' : 'tap to play'} · right-click or long-press to edit`}
                          style={{
                            width: '100%', aspectRatio: '1 / 1',
                            background: isPlaying ? 'rgba(201,168,76,0.28)' : isHot ? 'rgba(201,168,76,0.22)' : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${accent ? 'var(--accent)' : 'rgba(255,255,255,0.12)'}`,
                            borderRadius: '8px',
                            color: accent ? 'var(--accent)' : 'rgba(255,255,255,0.78)',
                            cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            padding: '4px', overflow: 'hidden',
                            transition: 'background 0.15s ease, border-color 0.15s ease',
                            fontSize: '9px', fontWeight: 600, letterSpacing: '0.3px', textAlign: 'center',
                            touchAction: 'manipulation',
                            WebkitTouchCallout: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                            animation: isPlaying ? 'sfxPadPulse 1.4s ease-in-out infinite' : undefined,
                          }}
                          onMouseEnter={e => { if (!accent) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                          onMouseLeave={e => { if (!accent) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                        >
                          <span style={{ fontSize: '16px', marginBottom: '4px', opacity: isPlaying ? 1 : 0.7 }}>
                            {isPlaying ? '⏹' : '🔊'}
                          </span>
                          <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{s.name}</span>
                        </button>
                      )
                    })}
                    {/* Upload pad */}
                    <button
                      onClick={() => sbFileInputRef.current?.click()}
                      disabled={sbUploading}
                      title="Upload sound"
                      style={{
                        width: '100%', aspectRatio: '1 / 1',
                        background: 'transparent',
                        border: '1.5px dashed rgba(255,255,255,0.18)', borderRadius: '8px',
                        color: 'rgba(255,255,255,0.4)', cursor: sbUploading ? 'wait' : 'pointer',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        fontSize: '20px', transition: 'border-color 0.15s ease, color 0.15s ease',
                        touchAction: 'manipulation',
                      }}
                      onMouseEnter={e => { if (!sbUploading) { e.currentTarget.style.borderColor = 'rgba(201,168,76,0.5)'; e.currentTarget.style.color = 'var(--accent)' } }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
                    >
                      {sbUploading ? <span style={{ fontSize: '10px', fontWeight: 600 }}>…</span> : '+'}
                    </button>
                  </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Soundboard quick-edit popover (right-click / long-press on a pad) ── */}
      {sbQuickEdit && (() => {
        const s = (sounds ?? []).find(x => x.id === sbQuickEdit.soundId)
        if (!s) return null
        const isSfxPlaying = (sfxActiveCounts[s.id] ?? 0) > 0
        // Backdrop ignores dismiss attempts within the grace window so the
        // trailing pointerup/click from the gesture that opened the popover
        // doesn't immediately close it.
        const tryDismiss = () => {
          if (Date.now() - sbQuickEditOpenedAtRef.current < 350) return
          setSbQuickEdit(null)
        }
        return (
          <>
            {/* Backdrop catches outside clicks */}
            <div
              onPointerDown={tryDismiss}
              onContextMenu={e => { e.preventDefault(); tryDismiss() }}
              style={{ position: 'fixed', inset: 0, zIndex: 60 }}
            />
            <div
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                top: sbQuickEdit.y, left: sbQuickEdit.x,
                width: '280px', zIndex: 61,
                background: 'rgba(18,20,30,0.99)',
                border: '1px solid rgba(255,255,255,0.16)',
                borderRadius: '10px', padding: '12px',
                boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
                display: 'flex', flexDirection: 'column', gap: '10px',
              }}
            >
              {/* Top row: preview · name input · close */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => playSfx(s)}
                  title={isSfxPlaying ? 'Stop' : 'Preview'}
                  style={{
                    width: '36px', height: '36px', flexShrink: 0, borderRadius: '6px',
                    border: `1px solid ${isSfxPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.15)'}`,
                    background: isSfxPlaying ? 'rgba(201,168,76,0.18)' : 'rgba(255,255,255,0.05)',
                    color: isSfxPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.75)',
                    fontSize: '12px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    touchAction: 'manipulation',
                  }}
                >{isSfxPlaying ? '⏹' : '▶'}</button>
                <input
                  type="text"
                  defaultValue={s.name}
                  spellCheck={false}
                  onBlur={e => handleSbRename(s, e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                    else if (e.key === 'Escape') setSbQuickEdit(null)
                  }}
                  style={{ flex: 1, minWidth: 0, height: '36px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '0 10px', color: 'rgba(255,255,255,0.9)', fontSize: '13px', fontFamily: 'inherit', outline: 'none' }}
                />
                <button
                  onClick={() => setSbQuickEdit(null)}
                  title="Close"
                  style={{ width: '36px', height: '36px', flexShrink: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.55)', cursor: 'pointer', fontSize: '14px', touchAction: 'manipulation' }}
                >✕</button>
              </div>
              {/* Volume — taller slider for easier touch drag */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '4px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '36px', flexShrink: 0 }}>Vol</span>
                <input
                  type="range" min={0} max={1} step={0.01} value={s.volume ?? 1}
                  onChange={e => handleSbVolume(s, Number(e.target.value))}
                  onClick={e => e.stopPropagation()}
                  onPointerDown={e => e.stopPropagation()}
                  onTouchStart={e => e.stopPropagation()}
                  style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: '32px', touchAction: 'none' }}
                />
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.65)', width: '36px', textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{Math.round((s.volume ?? 1) * 100)}%</span>
              </div>
              {/* Delete — first click arms (~4s), second click confirms */}
              <button
                onClick={() => {
                  if (sbDeleteArmed) {
                    if (sbDeleteArmedTimerRef.current) { clearTimeout(sbDeleteArmedTimerRef.current); sbDeleteArmedTimerRef.current = null }
                    setSbDeleteArmed(false)
                    setSbQuickEdit(null)
                    handleSbDelete(s)
                  } else {
                    setSbDeleteArmed(true)
                    if (sbDeleteArmedTimerRef.current) clearTimeout(sbDeleteArmedTimerRef.current)
                    sbDeleteArmedTimerRef.current = setTimeout(() => setSbDeleteArmed(false), 4000)
                  }
                }}
                title={sbDeleteArmed ? 'Click again to confirm' : 'Delete sound'}
                style={{
                  height: '34px', borderRadius: '6px',
                  border: `1px solid ${sbDeleteArmed ? 'rgba(229,53,53,0.55)' : 'rgba(255,255,255,0.1)'}`,
                  background: sbDeleteArmed ? 'rgba(229,53,53,0.18)' : 'rgba(255,255,255,0.04)',
                  color: sbDeleteArmed ? '#ff7a7a' : 'rgba(255,255,255,0.55)',
                  fontSize: '10px', fontWeight: 700, letterSpacing: '0.6px',
                  textTransform: 'uppercase', cursor: 'pointer',
                  touchAction: 'manipulation',
                }}
              >{sbDeleteArmed ? 'Click to confirm delete' : 'Delete'}</button>
            </div>
          </>
        )
      })()}

      {/* ── Handout lightbox ── */}
      {activeHandout && (
        <HandoutLightbox handout={activeHandout} onClose={() => showHandout(null)} />
      )}

      {/* ── Library lightbox — DM-local only, no broadcast ── */}
      {libraryHandout && (
        <HandoutLightbox handout={libraryHandout} onClose={() => setLibraryHandout(null)} />
      )}

      {/* ── DM Character Slots ──────────────────────────────────
          Two small slot buttons at bottom-center for live character control.
          Only shown when onCharactersChange is provided (DM view).
      ──────────────────────────────────────────────────────── */}
      {hasDMControls && (
        <div style={{ position: 'absolute', bottom: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, display: 'flex', gap: '8px' }}>
          {(['left', 'center', 'right'] as const).map(slot => {
            const char = characters?.[slot] ?? null
            const imgUrl = char ? characterImageUrl(char) : null
            return (
              <div key={slot} style={{ position: 'relative' }}>
                {/* Slot button */}
                <button
                  onPointerDown={e => {
                    e.preventDefault() // blocks subsequent synthetic click on Android
                    if (activeSlot === slot) { setActiveSlot(null); return }
                    const mode = char ? 'adjust' : 'pick'
                    if (mode === 'pick') pickerOpenTimeRef.current = Date.now()
                    setActiveSlot(slot)
                    setPanelMode(mode)
                  }}
                  title={char ? `Adjust ${slot} character` : `Add ${slot} character`}
                  style={{
                    width: '44px', height: '44px', borderRadius: '8px',
                    border: `1px solid ${char ? 'rgba(201,168,76,0.4)' : 'rgba(255,255,255,0.14)'}`,
                    background: char ? 'rgba(201,168,76,0.08)' : MIXER_BG,
                    cursor: 'pointer', overflow: 'hidden',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0, touchAction: 'manipulation',
                  }}
                >
                  {imgUrl
                    ? <img src={imgUrl} alt={char!.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', fontWeight: 700 }}>{slot === 'left' ? 'L' : slot === 'center' ? 'C' : 'R'}+</span>
                  }
                </button>

                {/* Remove button on hover */}
                {char && (
                  <button
                    onClick={e => { e.stopPropagation(); removeCharacter(slot) }}
                    onTouchEnd={e => { e.preventDefault(); e.stopPropagation(); removeCharacter(slot) }}
                    style={{ position: 'absolute', top: '-6px', right: '-6px', width: '18px', height: '18px', borderRadius: '50%', background: 'var(--accent)', border: 'none', color: '#fff', fontSize: '9px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, zIndex: 2, touchAction: 'manipulation' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Adjust panel (character in slot) ──────────────────── */}
      {activeSlot && panelMode === 'adjust' && hasDMControls && characters?.[activeSlot] && (() => {
        const slot    = activeSlot
        const char    = characters[slot]!
        const imgUrl  = characterImageUrl(char)
        const scale   = slotScales?.[slot] ?? 1
        const display = slotDisplayProps?.[slot] ?? DEFAULT_CHAR_DISPLAY
        const zoom    = display.zoom  ?? 1
        const panX    = display.panX  ?? 50
        const panY    = display.panY  ?? 100
        const zoomed  = zoom > 1.05
        function fire(newScale: number, newDisplay: SlotDisplay) {
          onSlotDisplayChange?.(slot, newScale, newDisplay)
        }
        return (
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{ position: 'absolute', bottom: '70px', left: '50%', transform: 'translateX(-50%)', zIndex: 30, width: '300px', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
          >
            {/* Header */}
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '6px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {imgUrl ? <img src={imgUrl} alt={char.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: '14px' }}>🧑</span>}
              </div>
              <span style={{ flex: 1, fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{char.name}</span>
              <button
                onClick={() => { setPanelMode('pick'); pickerOpenTimeRef.current = Date.now() }}
                style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.8px', padding: '5px 10px', borderRadius: 'var(--r-sm)', border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0 }}
              >Change</button>
              <button onClick={() => setActiveSlot(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px', flexShrink: 0, touchAction: 'manipulation' }}>✕</button>
            </div>

            {/* Controls */}
            <div style={{ padding: '10px 14px 14px' }}>
              {/* Scale */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '34px', flexShrink: 0 }}>Scale</span>
                <input type="range" min={0.5} max={2.5} step={0.05} value={scale}
                  onChange={e => fire(Number(e.target.value), display)}
                  style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: '44px', touchAction: 'none' }}
                />
                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', width: '34px', textAlign: 'right', flexShrink: 0 }}>{Math.round(scale * 100)}%</span>
              </div>

              {/* Zoom */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '34px', flexShrink: 0 }}>Zoom</span>
                <input type="range" min={1} max={3} step={0.05} value={zoom}
                  onChange={e => fire(scale, { ...display, zoom: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: '44px', touchAction: 'none' }}
                />
                <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', width: '34px', textAlign: 'right', flexShrink: 0 }}>{zoom.toFixed(1)}x</span>
              </div>

              {/* Pan sliders — only shown when zoomed in */}
              {zoomed && [
                { label: 'Pan X', val: panX, onChange: (v: number) => fire(scale, { ...display, panX: v }) },
                { label: 'Pan Y', val: panY, onChange: (v: number) => fire(scale, { ...display, panY: v }) },
              ].map(({ label, val, onChange }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '34px', flexShrink: 0 }}>{label}</span>
                  <input type="range" min={0} max={100} step={1} value={val}
                    onChange={e => onChange(Number(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: '44px', touchAction: 'none' }}
                  />
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', width: '34px', textAlign: 'right', flexShrink: 0 }}>{val}%</span>
                </div>
              ))}

              {/* Flip row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '34px', flexShrink: 0 }}>Flip</span>
                <button onClick={() => fire(scale, { ...display, flipped: !display.flipped })}
                  style={{
                    fontSize: '10px', minHeight: '36px', padding: '0 14px', borderRadius: 'var(--r-sm)', cursor: 'pointer', touchAction: 'manipulation',
                    background: display.flipped ? 'var(--accent-bg)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${display.flipped ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`,
                    color: display.flipped ? 'var(--accent)' : 'rgba(255,255,255,0.4)',
                  }}
                >↔ Mirror</button>
              </div>

              {/* Layer row — when on, character renders in front of scene
                  overlays (fog/godrays/dust pass behind them instead of over). */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', width: '34px', flexShrink: 0 }}>Layer</span>
                <button onClick={() => fire(scale, { ...display, aboveOverlay: !display.aboveOverlay })}
                  style={{
                    fontSize: '10px', minHeight: '36px', padding: '0 14px', borderRadius: 'var(--r-sm)', cursor: 'pointer', touchAction: 'manipulation',
                    background: display.aboveOverlay ? 'var(--accent-bg)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${display.aboveOverlay ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`,
                    color: display.aboveOverlay ? 'var(--accent)' : 'rgba(255,255,255,0.4)',
                  }}
                >⬆ Above FX</button>
              </div>

              {/* Save button */}
              {onSaveSlotDisplay && (
                <button
                  onClick={async () => {
                    await onSaveSlotDisplay(slot)
                    setSavedConfirm(true)
                    if (savedConfirmTimerRef.current) clearTimeout(savedConfirmTimerRef.current)
                    savedConfirmTimerRef.current = setTimeout(() => setSavedConfirm(false), 1800)
                  }}
                  style={{
                    width: '100%', minHeight: '40px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                    touchAction: 'manipulation', fontWeight: 700, fontSize: '11px',
                    letterSpacing: '1px', textTransform: 'uppercase', border: 'none',
                    background: savedConfirm ? 'rgba(201,168,76,0.2)' : 'var(--accent)',
                    color: savedConfirm ? 'var(--accent)' : '#13151d',
                    transition: 'background 0.2s, color 0.2s',
                  }}
                >
                  {savedConfirm ? '✓ Saved' : 'Save Position'}
                </button>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Character Picker Popup ──────────────────────────────── */}
      {activeSlot && panelMode === 'pick' && hasDMControls && (
        <div
          onPointerDown={e => e.stopPropagation()}
          style={{ position: 'absolute', bottom: '70px', left: '50%', transform: 'translateX(-50%)', zIndex: 30, width: '260px', background: 'rgba(18,20,30,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.8)' }}
        >
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', flex: 1 }}>
              {activeSlot === 'left' ? 'Left' : activeSlot === 'center' ? 'Center' : 'Right'} Character
            </span>
            {characters?.[activeSlot] && (
              <button onClick={() => setPanelMode('adjust')} style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.8px', padding: '4px 8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', touchAction: 'manipulation' }}>← Back</button>
            )}
            <button onClick={() => setActiveSlot(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
          </div>
          <div style={{ padding: '8px 12px' }}>
            <input
              autoFocus={!isTouchDevice.current}
              placeholder="Search characters…"
              value={charSearch}
              onChange={e => setCharSearch(e.target.value)}
              style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 10px', color: '#fff', fontSize: '12px', outline: 'none' }}
            />
          </div>
          <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '0 8px 8px' }}>
            {filteredChars.length === 0 && (
              <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'rgba(255,255,255,0.2)' }}>
                {campaignCharacters?.length === 0 ? 'No characters yet — add them in the scene editor' : 'No matches'}
              </div>
            )}
            {filteredChars.map(c => {
              const img = characterImageUrl(c)
              return (
                <button
                  key={c.id}
                  onClick={() => pickCharacter(c)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 8px', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: '6px', textAlign: 'left', transition: 'background .1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ width: '36px', height: '36px', borderRadius: '6px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {img
                      ? <img src={img} alt={c.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ fontSize: '16px' }}>🧑</span>
                    }
                  </div>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>{c.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Click-away to close panel.
          Time guard: ignore pointer events within 300ms of the picker opening —
          catches the synthetic click Android fires after touchend. */}
      {activeSlot && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 25 }}
          onPointerDown={() => {
            if (panelMode === 'pick' && Date.now() - pickerOpenTimeRef.current <= 300) return
            setActiveSlot(null)
          }}
        />
      )}

      {/* ── Audio Mixer ── */}
      {hasTracks && (
        <div style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', [mixerPos === 'top-left' ? 'left' : 'right']: `calc(14px + env(safe-area-inset-${mixerPos === 'top-left' ? 'left' : 'right'}))`, zIndex: 20, width: 'var(--stage-mixer-w)' }}>
          <div onClick={() => setExpanded(e => !e)}
            style={{ background: MIXER_BG, border: '1px solid rgba(255,255,255,0.14)', borderRadius: expanded ? '10px 10px 0 0' : '10px', padding: '0 10px', height: '44px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '16px', flexShrink: 0 }}>
              {[1, 0.6, 0.85, 0.45, 0.7].map((h, i) => (
                <div key={i} style={{ width: '3px', borderRadius: '1px', background: playingCount > 0 ? 'var(--accent)' : 'rgba(255,255,255,0.2)', height: `${Math.round(h * 16)}px`, animation: playingCount > 0 ? `audioBar${i} ${0.6 + i * 0.15}s ease-in-out infinite alternate` : 'none' }} />
              ))}
            </div>
            <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', flex: 1, minWidth: 0 }}>Audio</span>
            {isLive && <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '1px', color: '#ff5555', background: 'rgba(255,85,85,0.12)', border: '1px solid rgba(255,85,85,0.3)', borderRadius: '4px', padding: '2px 6px', flexShrink: 0 }}>LIVE</span>}
            {playingCount > 0 && <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>{playingCount}</span>}
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
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
          </div>

          {expanded && (
            <div style={{ background: MIXER_BG_PANEL, border: '1px solid rgba(255,255,255,0.14)', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
              {/* ── Base music (playlist) ── */}
              {baseMusic.length > 0 && (
                <div style={{ padding: '10px 14px 6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', flex: 1 }}>🎵 Music</span>
                    {baseMusic.length > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <button onClick={e => { e.stopPropagation(); switchMusicTrack(clampedMusicIdx - 1) }} disabled={clampedMusicIdx === 0}
                          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: clampedMusicIdx === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)', fontSize: '11px', height: '22px', width: '22px', cursor: clampedMusicIdx === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⏮</button>
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', minWidth: '28px', textAlign: 'center' }}>{clampedMusicIdx + 1}/{baseMusic.length}</span>
                        <button onClick={e => { e.stopPropagation(); switchMusicTrack(clampedMusicIdx + 1) }} disabled={clampedMusicIdx === baseMusic.length - 1}
                          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: clampedMusicIdx === baseMusic.length - 1 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.5)', fontSize: '11px', height: '22px', width: '22px', cursor: clampedMusicIdx === baseMusic.length - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⏭</button>
                      </div>
                    )}
                  </div>
                  {currentMusicTrack && (
                    <MiniTrackRow key={currentMusicTrack.id} t={currentMusicTrack} isPlaying={trackPlaying(currentMusicTrack)} volume={trackVolume(currentMusicTrack)} onToggle={() => toggleTrack(currentMusicTrack)} onVol={v => setVol(currentMusicTrack, v)} nowPlaying={currentMusicTrack.spotify_uri && trackPlaying(currentMusicTrack) ? spotify.nowPlaying : null} progress={currentMusicTrack.spotify_uri && trackPlaying(currentMusicTrack) ? spotify.progress : undefined} onSkip={currentMusicTrack.spotify_uri ? d => spotify.skip(d) : undefined} />
                  )}
                </div>
              )}

              {/* ── Dynamic layers (ml2/ml3) ── */}
              {layers.length > 0 && (
                <>
                  {(baseMusic.length > 0) && <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0 14px' }} />}
                  <div style={{ padding: '10px 14px 6px' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '8px' }}>🎚 Layers</div>
                    {layers.map(t => <MiniTrackRow key={t.id} t={t} isPlaying={trackPlaying(t)} volume={trackVolume(t)} onToggle={() => toggleTrack(t)} onVol={v => setVol(t, v)} nowPlaying={t.spotify_uri && trackPlaying(t) ? spotify.nowPlaying : null} progress={t.spotify_uri && trackPlaying(t) ? spotify.progress : undefined} onSkip={t.spotify_uri ? d => spotify.skip(d) : undefined} />)}
                  </div>
                </>
              )}

              {/* ── Ambience (all simultaneous) ── */}
              {(baseMusic.length > 0 || layers.length > 0) && amb.length > 0 && <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0 14px' }} />}
              {amb.length > 0 && (
                <div style={{ padding: '10px 14px 6px', ...(isLive ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
                  <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    🌊 Ambience
                    {isLive && <span style={{ fontSize: '8px', color: 'rgba(255,85,85,0.5)', fontWeight: 600, letterSpacing: '0.5px' }}>· viewer only</span>}
                  </div>
                  {amb.map(t => <MiniTrackRow key={t.id} t={t} isPlaying={trackPlaying(t)} volume={trackVolume(t)} onToggle={() => toggleTrack(t)} onVol={v => setVol(t, v)} nowPlaying={t.spotify_uri && trackPlaying(t) ? spotify.nowPlaying : null} progress={t.spotify_uri && trackPlaying(t) ? spotify.progress : undefined} onSkip={t.spotify_uri ? d => spotify.skip(d) : undefined} />)}
                </div>
              )}

              <div style={{ padding: '8px 14px 10px', display: 'flex', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <button onClick={e => { e.stopPropagation(); stopAll() }} style={{ flex: 1, height: '44px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.6)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>⏹ Stop All</button>
                <button onClick={e => { e.stopPropagation(); handleMute() }} style={{ width: '44px', height: '44px', background: muted ? 'var(--accent-bg)' : 'rgba(255,255,255,0.06)', border: `1px solid ${muted ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', color: muted ? 'var(--accent)' : 'rgba(255,255,255,0.6)', fontSize: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
        @keyframes sfxPadPulse{0%,100%{box-shadow:0 0 0 0 rgba(201,168,76,0)}50%{box-shadow:0 0 0 3px rgba(201,168,76,0.25)}}
      `}</style>
    </div>
  )
}

import type { SpotifyNowPlaying } from '@/lib/useSpotifyPlayer'

// ── Soundboard edit row ────────────────────────────────────────
// Renders one sound in edit mode: preview play, name input (saves on
// blur/Enter), volume slider, and a 2-stage delete (one click arms a
// red confirm; second click within 4s confirms; click anywhere else
// or wait → cancels).

interface MiniTrackRowProps {
  t:          Track
  isPlaying:  boolean
  volume:     number
  onToggle:   () => void
  onVol:      (v: number) => void
  nowPlaying?: SpotifyNowPlaying | null
  progress?:  number   // 0–1, only for active Spotify tracks
  onSkip?:    (direction: 'next' | 'previous') => void
}

function MiniTrackRow({ t, isPlaying, volume, onToggle, onVol, nowPlaying, progress, onSkip }: MiniTrackRowProps) {
  const isSpotify    = !!t.spotify_uri
  const showMeta     = isSpotify && isPlaying && !!nowPlaying
  const showProgress = isSpotify && isPlaying && typeof progress === 'number'
  const showSkip     = isSpotify && isPlaying && !!onSkip && t.spotify_type === 'playlist'

  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Album art — shown for active Spotify tracks */}
        {showMeta && nowPlaying?.albumArt && (
          <img
            src={nowPlaying.albumArt}
            alt=""
            width={36} height={36}
            style={{ borderRadius: '4px', flexShrink: 0, objectFit: 'cover' }}
          />
        )}
        <button
          onClick={e => { e.stopPropagation(); onToggle() }}
          style={{ width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0, border: `1px solid ${isPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.15)'}`, background: isPlaying ? 'var(--accent-bg)' : 'rgba(255,255,255,0.05)', color: isPlaying ? 'var(--accent)' : 'rgba(255,255,255,0.5)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Track name — real Spotify title when playing, label name otherwise */}
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.65)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: showMeta ? '2px' : '6px' }}>
            {showMeta ? nowPlaying!.name : t.name}
          </div>
          {/* Artist name */}
          {showMeta && (
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '4px' }}>
              {nowPlaying!.artist}
            </div>
          )}
          <input type="range" min={0} max={1} step={0.01} value={volume} onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()} onChange={e => { e.stopPropagation(); onVol(Number(e.target.value)) }} style={{ width: '100%', height: '20px', accentColor: 'var(--accent)', cursor: 'pointer', touchAction: 'none' }} />
        </div>
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div style={{ marginTop: '6px', height: '2px', background: 'rgba(255,255,255,0.1)', borderRadius: '1px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(progress ?? 0) * 100}%`, background: '#1ed760', borderRadius: '1px', transition: 'width 0.5s linear' }} />
        </div>
      )}

      {/* Skip controls — only shown for playlists */}
      {showSkip && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '6px', justifyContent: 'center' }}>
          <button onClick={e => { e.stopPropagation(); onSkip!('previous') }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', fontSize: '13px', height: '32px', padding: '0 14px', cursor: 'pointer' }}>⏮</button>
          <button onClick={e => { e.stopPropagation(); onSkip!('next')     }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', fontSize: '13px', height: '32px', padding: '0 14px', cursor: 'pointer' }}>⏭</button>
        </div>
      )}
    </div>
  )
}
