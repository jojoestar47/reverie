'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resolveSceneUrls, resolveCharacterUrls, publicStorageUrl, uploadMedia, deleteMedia, deleteMediaBatch } from '@/lib/supabase/storage'
import type { Scene, SceneFolder, Character, CampaignTag, CharacterState, Handout, OverlayLiveState, CampaignSound, SfxEvent } from '@/lib/types'
import Stage              from '@/components/Stage'
import HandoutLightbox    from '@/components/HandoutLightbox'
import SceneList           from '@/components/SceneList'
import SceneEditor         from '@/components/SceneEditor'
import CampaignHome        from '@/components/CampaignHome'
import CharacterRoster     from '@/components/CharacterRoster'
import AppIcon             from '@/components/AppIcon'
import SpotifyConnect      from '@/components/SpotifyConnect'
import ShareLiveModal      from '@/components/ShareLiveModal'
import NewCampaignModal    from '@/components/NewCampaignModal'
import ConfirmModal        from '@/components/ConfirmModal'
import { useSpotifyPlayer } from '@/lib/useSpotifyPlayer'
import { useCampaignData } from '@/lib/useCampaignData'

function makeJoinCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => chars[b % chars.length]).join('')
}

const DEFAULT_SLOT_DISPLAY = { zoom: 1, panX: 50, panY: 100, flipped: false, aboveOverlay: false }

interface ActiveCharacters {
  left:   Character | null
  center: Character | null
  right:  Character | null
}

export default function AppPage() {
  const supabase = createClient()

  // ── UI state (modals, panels, transient selection) ────────────
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [sidebarOpen,      setSidebarOpen]      = useState(true)
  const [activeHandout,    setActiveHandout]    = useState<Handout | null>(null)
  const [userId,           setUserId]           = useState<string>('')
  const [activeCampId,     setActiveCampId]     = useState<string>('')
  const [activeSceneId,    setActiveSceneId]    = useState<string>('')
  const [editorOpen,       setEditorOpen]       = useState(false)
  const [editorSceneId,    setEditorSceneId]    = useState<string | null>(null)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const newSceneFolderRef = useRef<string | null>(null)
  const [newCampName,    setNewCampName]    = useState('')
  const [campModalOpen,  setCampModalOpen]  = useState(false)
  const [copied,         setCopied]         = useState(false)
  const [campView,       setCampView]       = useState<'stage' | 'characters'>('stage')
  const [shareModalOpen, setShareModalOpen] = useState(false)

  // ── Transient stage state (ephemeral DM framing) ──────────────
  const [slotScales,       setSlotScales]       = useState({ left: 1, center: 1, right: 1 })
  const [slotDisplayProps, setSlotDisplayProps] = useState({
    left:   DEFAULT_SLOT_DISPLAY,
    center: DEFAULT_SLOT_DISPLAY,
    right:  DEFAULT_SLOT_DISPLAY,
  })
  const [activeOverlays, setActiveOverlays] = useState<Record<string, OverlayLiveState>>({})
  const overlayDbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Slider drags on character framing fire onChange ~60×/sec — debounce
  // the DB write so we send one UPDATE per gesture instead of stomping the
  // viewer with realtime events. The pending payload lives in a ref so the
  // timer always flushes the latest values, not those captured at schedule.
  const charStateDbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCharStateRef = useRef<CharacterState | null>(null)
  // Clear pending timers on unmount so a stale write doesn't fire after the
  // user signs out or navigates away.
  useEffect(() => () => {
    if (overlayDbTimerRef.current)   clearTimeout(overlayDbTimerRef.current)
    if (charStateDbTimerRef.current) clearTimeout(charStateDbTimerRef.current)
  }, [])

  // ── Undo-delete: scene removed from UI immediately, DB delete after 5s ──
  interface PendingSceneDelete { scene: Scene; insertAfterId: string | null; timer: ReturnType<typeof setTimeout> }
  const [pendingSceneDeletes, setPendingSceneDeletes] = useState<Record<string, PendingSceneDelete>>({})
  const pendingSceneDeletesRef = useRef<Record<string, PendingSceneDelete>>({})
  function setPendingDeletes(updater: (prev: Record<string, PendingSceneDelete>) => Record<string, PendingSceneDelete>) {
    setPendingSceneDeletes(prev => {
      const next = updater(prev)
      pendingSceneDeletesRef.current = next
      return next
    })
  }

  // ── Confirm modal ─────────────────────────────────────────────
  interface ConfirmState { title: string; body: string; confirmLabel: string; onConfirm: () => void }
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  function openConfirm(opts: ConfirmState) { setConfirmState(opts) }

  // ── Error toasts ──────────────────────────────────────────────
  interface Toast { id: string; message: string }
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => toastTimersRef.current.forEach(clearTimeout), [])

  function showError(message: string) {
    const id = Math.random().toString(36).slice(2)
    setToasts(prev => [...prev, { id, message }])
    const t = setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
    toastTimersRef.current.push(t)
  }

  // Wraps a Supabase write so a failing call surfaces a toast instead of
  // silently letting optimistic local state diverge from the database.
  // Returns true on success — callers that need to roll back can branch on it.
  async function reportDbError(promise: PromiseLike<{ error: unknown }>, message: string): Promise<boolean> {
    const { error } = await promise
    if (error) { showError(message); return false }
    return true
  }

  // ── Auth ──────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserId(user.id)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persistent data + live session (Realtime + loaders) ───────
  // The hook owns all the data-loading useEffects, the sessions Realtime
  // subscription, and the cross-tab character-state sync. It exposes setters
  // so the CRUD handlers below can push results back without re-fetching.
  const data = useCampaignData(activeCampId, {
    onSignedOut: () => { window.location.href = '/login' },
    flushPendingDeletes: () => {
      // Flush pending scene deletes from the previous campaign immediately so
      // timers don't fire against a campaign the user is no longer on.
      const pending = pendingSceneDeletesRef.current
      if (Object.keys(pending).length === 0) { setActiveSceneId(''); setCampView('stage'); return }
      Object.values(pending).forEach(p => { clearTimeout(p.timer); executeSceneDelete(p.scene) })
      setPendingDeletes(() => ({}))
      setActiveSceneId('')
      setCampView('stage')
    },
    onActiveSceneIdChange: id => setActiveSceneId(id),
  })
  const {
    campaigns, scenes, folders, campaignCharacters, campaignTags, campaignSounds, campaignHandouts, loading,
    sessionId, joinCode, isLive, activeCharacters,
    sceneRosterChars, characterScales, characterDisplayDefaults,
    setCampaigns, setScenes, setFolders, setCampaignCharacters, setCampaignTags, setCampaignSounds, setCampaignHandouts,
    setSessionId, setJoinCode, setIsLive, setActiveCharacters,
    setSceneRosterChars, setCharacterScales, setCharacterDisplayDefaults,
    loadSceneRoster,
  } = data

  // ── On scene change: clear stage slots + load this scene's pool ──
  // Stage always starts empty — DM places characters manually each session.
  useEffect(() => {
    setActiveCharacters({ left: null, center: null, right: null })
    setSlotScales({ left: 1, center: 1, right: 1 })
    setSlotDisplayProps({ left: DEFAULT_SLOT_DISPLAY, center: DEFAULT_SLOT_DISPLAY, right: DEFAULT_SLOT_DISPLAY })
    setActiveHandout(null)
    if (!activeSceneId) {
      // Drop the previous scene's roster/framing so they don't leak into
      // the next view (e.g. switching campaigns leaves activeSceneId='' for
      // a moment).
      setSceneRosterChars([]); setCharacterScales({}); setCharacterDisplayDefaults({})
      setActiveOverlays({})
      return
    }
    // Initialize overlay live state from the scene's authored defaults
    const scene = scenes.find(s => s.id === activeSceneId)
    const overlayInit: Record<string, OverlayLiveState> = {}
    for (const o of scene?.overlays ?? []) {
      overlayInit[o.id] = { on: o.enabled_default, opacity: o.opacity }
    }
    setActiveOverlays(overlayInit)
    loadSceneRoster(activeSceneId)
  }, [activeSceneId]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeCampaign = campaigns.find(c => c.id === activeCampId) || null
  const activeScene    = scenes.find(s => s.id === activeSceneId)   || null
  const editorScene    = editorSceneId ? (scenes.find(s => s.id === editorSceneId) || null) : null

  // ── Spotify player (owned here, not in Stage) ─────────────────
  // Keeping the hook at page level means the SDK player is never torn down
  // when the user navigates between the home screen and a campaign.
  // Previously it lived in Stage — Stage unmounting called player.disconnect(),
  // and the SDK's ready event doesn't reliably fire again on subsequent
  // connect() calls, breaking auto-play on every visit after the first.
  // disableAutoPlay: while live the viewer device is the sole playback master.
  const spotify = useSpotifyPlayer(activeScene, { disableAutoPlay: isLive })
  const viewerUrl      = typeof window !== 'undefined' && joinCode ? `${window.location.origin}/view/${joinCode}` : null
  const qrUrl          = viewerUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(viewerUrl)}&margin=12` : null

  // ── Session: Start / Stop Presenting ─────────────────────────
  async function startPresenting() {
    if (!activeCampId || !userId) return
    if (sessionId && isLive) { setShareModalOpen(true); return }
    const code = makeJoinCode()
    const cs: CharacterState = {
      left: activeCharacters.left?.id || null, center: activeCharacters.center?.id || null, right: activeCharacters.right?.id || null,
      leftScale: slotScales.left, centerScale: slotScales.center, rightScale: slotScales.right,
      leftZoom: slotDisplayProps.left.zoom, centerZoom: slotDisplayProps.center.zoom, rightZoom: slotDisplayProps.right.zoom,
      leftPanX: slotDisplayProps.left.panX, centerPanX: slotDisplayProps.center.panX, rightPanX: slotDisplayProps.right.panX,
      leftPanY: slotDisplayProps.left.panY, centerPanY: slotDisplayProps.center.panY, rightPanY: slotDisplayProps.right.panY,
      leftFlipped: slotDisplayProps.left.flipped, centerFlipped: slotDisplayProps.center.flipped, rightFlipped: slotDisplayProps.right.flipped,
      leftAboveOverlay: slotDisplayProps.left.aboveOverlay, centerAboveOverlay: slotDisplayProps.center.aboveOverlay, rightAboveOverlay: slotDisplayProps.right.aboveOverlay,
    }
    // Explicitly null out every "live state" column the DM hasn't touched yet
    // so a fresh presentation never inherits stale state from a previous run
    // (overlays toggled on, a handout left up, an old SFX event re-firing).
    // The sessions row is unique per campaign, so ending and restarting always
    // reuses the same row and these would otherwise carry over.
    const { data, error } = await supabase.from('sessions').upsert({
      campaign_id: activeCampId, join_code: code,
      active_scene_id: activeSceneId || null, is_live: true,
      created_by: userId, character_state: cs,
      active_handout_id:     null,
      active_music_track_id: null,
      active_overlays:       null,
      active_sfx_event:      null,
    }, { onConflict: 'campaign_id' }).select('id, join_code').single()
    if (error) {
      console.error('[startPresenting] upsert failed:', error)
      showError('Failed to start presentation. Try again.')
      return
    }
    if (data) { setSessionId(data.id); setJoinCode(data.join_code); setIsLive(true); setShareModalOpen(true) }
  }

  async function stopPresenting() {
    if (!sessionId) return
    await reportDbError(
      supabase.from('sessions').update({ is_live: false }).eq('id', sessionId),
      'Failed to end live session.',
    )
    setIsLive(false); setSessionId(null); setJoinCode(null)
  }

  async function handleHandoutShow(handoutId: string | null) {
    if (!sessionId || !isLive) return
    await reportDbError(
      supabase.from('sessions').update({ active_handout_id: handoutId }).eq('id', sessionId),
      'Failed to update handout for viewers.',
    )
  }

  async function handleMusicTrackChange(trackId: string | null) {
    if (!sessionId || !isLive) return
    await reportDbError(
      supabase.from('sessions').update({ active_music_track_id: trackId }).eq('id', sessionId),
      'Failed to update music track for viewers.',
    )
  }

  async function handlePlaySfx(sound: CampaignSound) {
    if (!sessionId || !isLive) return
    const ev: SfxEvent = {
      id: `${sound.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sound_id: sound.id,
      played_at: Date.now(),
      volume: sound.volume,
    }
    await reportDbError(
      supabase.from('sessions').update({ active_sfx_event: ev }).eq('id', sessionId),
      'Failed to trigger sound for viewers.',
    )
  }

  async function handleStopSfx(soundId: string) {
    if (!sessionId || !isLive) return
    const ev: SfxEvent = {
      id: `${soundId}-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sound_id: soundId,
      played_at: Date.now(),
      stop: true,
    }
    await reportDbError(
      supabase.from('sessions').update({ active_sfx_event: ev }).eq('id', sessionId),
      'Failed to stop sound for viewers.',
    )
  }

  function handleOverlayStateChange(id: string, state: OverlayLiveState) {
    const next = { ...activeOverlays, [id]: state }
    setActiveOverlays(next)
    if (!sessionId || !isLive) return
    // Debounce the DB write — slider drags can fire 60×/sec and each write
    // triggers a realtime event on the viewer. Local state updates immediately.
    if (overlayDbTimerRef.current) clearTimeout(overlayDbTimerRef.current)
    overlayDbTimerRef.current = setTimeout(() => {
      void reportDbError(
        supabase.from('sessions').update({ active_overlays: next }).eq('id', sessionId),
        'Failed to update overlays for viewers.',
      )
    }, 150)
  }

  // ── Scene + character selection ───────────────────────────────
  async function handleSelectScene(id: string) {
    setActiveSceneId(id)
    if (isLive && sessionId) {
      // Cancel any pending debounced overlay write — its `next` was computed
      // for the OLD scene and would clobber the active_overlays:null we're
      // about to write for the NEW scene. Same for character framing.
      if (overlayDbTimerRef.current) { clearTimeout(overlayDbTimerRef.current); overlayDbTimerRef.current = null }
      if (charStateDbTimerRef.current) { clearTimeout(charStateDbTimerRef.current); charStateDbTimerRef.current = null }
      pendingCharStateRef.current = null
      // Clear character state when switching scenes — DM places characters
      // manually on the stage rather than auto-loading saved assignments.
      const cs: CharacterState = {
        left: null, center: null, right: null,
        leftScale: 1, centerScale: 1, rightScale: 1,
        leftZoom: 1, centerZoom: 1, rightZoom: 1,
        leftPanX: 50, centerPanX: 50, rightPanX: 50,
        leftPanY: 100, centerPanY: 100, rightPanY: 100,
        leftFlipped: false, centerFlipped: false, rightFlipped: false,
        leftAboveOverlay: false, centerAboveOverlay: false, rightAboveOverlay: false,
      }
      const { error } = await supabase.from('sessions').update({ active_scene_id: id, character_state: cs, active_music_track_id: null, active_handout_id: null, active_overlays: null }).eq('id', sessionId)
      if (error) showError('Failed to switch scene for viewers.')
    }
  }

  async function handleCharactersChange(chars: ActiveCharacters) {
    // Scale follows the character — look up each character's saved default scale.
    const newScales = {
      left:   chars.left   ? (characterScales[chars.left.id]   ?? 1) : 1,
      center: chars.center ? (characterScales[chars.center.id] ?? 1) : 1,
      right:  chars.right  ? (characterScales[chars.right.id]  ?? 1) : 1,
    }
    // Use saved display defaults for any slot where the character changed.
    const newDisplay = { ...slotDisplayProps }
    if (chars.left?.id   !== activeCharacters.left?.id)   newDisplay.left   = chars.left   ? (characterDisplayDefaults[chars.left.id]   ?? DEFAULT_SLOT_DISPLAY) : DEFAULT_SLOT_DISPLAY
    if (chars.center?.id !== activeCharacters.center?.id) newDisplay.center = chars.center ? (characterDisplayDefaults[chars.center.id] ?? DEFAULT_SLOT_DISPLAY) : DEFAULT_SLOT_DISPLAY
    if (chars.right?.id  !== activeCharacters.right?.id)  newDisplay.right  = chars.right  ? (characterDisplayDefaults[chars.right.id]  ?? DEFAULT_SLOT_DISPLAY) : DEFAULT_SLOT_DISPLAY
    setSlotScales(newScales)
    setSlotDisplayProps(newDisplay)
    setActiveCharacters(chars)
    if (isLive && sessionId) {
      // Placement changes the character identity in a slot — flush any
      // pending debounced framing write so the immediate placement update
      // doesn't get clobbered by a stale slider write 150ms later.
      if (charStateDbTimerRef.current) { clearTimeout(charStateDbTimerRef.current); charStateDbTimerRef.current = null }
      pendingCharStateRef.current = null
      const cs: CharacterState = {
        left: chars.left?.id || null, center: chars.center?.id || null, right: chars.right?.id || null,
        leftScale: newScales.left, centerScale: newScales.center, rightScale: newScales.right,
        leftZoom: newDisplay.left.zoom, centerZoom: newDisplay.center.zoom, rightZoom: newDisplay.right.zoom,
        leftPanX: newDisplay.left.panX, centerPanX: newDisplay.center.panX, rightPanX: newDisplay.right.panX,
        leftPanY: newDisplay.left.panY, centerPanY: newDisplay.center.panY, rightPanY: newDisplay.right.panY,
        leftFlipped: newDisplay.left.flipped, centerFlipped: newDisplay.center.flipped, rightFlipped: newDisplay.right.flipped,
        leftAboveOverlay: newDisplay.left.aboveOverlay, centerAboveOverlay: newDisplay.center.aboveOverlay, rightAboveOverlay: newDisplay.right.aboveOverlay,
      }
      await supabase.from('sessions').update({ character_state: cs }).eq('id', sessionId)
    }
  }

  function handleSlotDisplayChange(
    slot: 'left' | 'center' | 'right',
    scale: number,
    display: { zoom?: number; panX?: number; panY?: number; flipped?: boolean; aboveOverlay?: boolean }
  ) {
    const newScales  = { ...slotScales,       [slot]: scale   }
    const newDisplay = { ...slotDisplayProps, [slot]: display }
    setSlotScales(newScales)
    setSlotDisplayProps(newDisplay)
    if (!isLive || !sessionId) return
    pendingCharStateRef.current = {
      left: activeCharacters.left?.id || null, center: activeCharacters.center?.id || null, right: activeCharacters.right?.id || null,
      leftScale: newScales.left, centerScale: newScales.center, rightScale: newScales.right,
      leftZoom: newDisplay.left.zoom, centerZoom: newDisplay.center.zoom, rightZoom: newDisplay.right.zoom,
      leftPanX: newDisplay.left.panX, centerPanX: newDisplay.center.panX, rightPanX: newDisplay.right.panX,
      leftPanY: newDisplay.left.panY, centerPanY: newDisplay.center.panY, rightPanY: newDisplay.right.panY,
      leftFlipped: newDisplay.left.flipped, centerFlipped: newDisplay.center.flipped, rightFlipped: newDisplay.right.flipped,
      leftAboveOverlay: newDisplay.left.aboveOverlay, centerAboveOverlay: newDisplay.center.aboveOverlay, rightAboveOverlay: newDisplay.right.aboveOverlay,
    }
    if (charStateDbTimerRef.current) clearTimeout(charStateDbTimerRef.current)
    charStateDbTimerRef.current = setTimeout(() => {
      const cs = pendingCharStateRef.current
      pendingCharStateRef.current = null
      charStateDbTimerRef.current = null
      if (!cs) return
      void reportDbError(
        supabase.from('sessions').update({ character_state: cs }).eq('id', sessionId),
        'Failed to update character framing for viewers.',
      )
    }, 150)
  }

  async function handleSaveSlotDisplay(slot: 'left' | 'center' | 'right') {
    const char = activeCharacters[slot]
    if (!char || !activeSceneId) return
    const display = slotDisplayProps[slot]
    const scale   = slotScales[slot]
    // Persist framing for this character in this scene.
    // Stage placement is always manual — only the framing (scale/zoom/pan/flip) is saved.
    await supabase.from('scene_characters')
      .upsert({
        scene_id:      activeSceneId,
        character_id:  char.id,
        scale,
        zoom:          display.zoom         ?? 1,
        pan_x:         display.panX         ?? 50,
        pan_y:         display.panY         ?? 100,
        flipped:       display.flipped      ?? false,
        above_overlay: display.aboveOverlay ?? false,
      }, { onConflict: 'scene_id,character_id' })
    setCharacterDisplayDefaults(prev => ({
      ...prev,
      [char.id]: { zoom: display.zoom ?? 1, panX: display.panX ?? 50, panY: display.panY ?? 100, flipped: display.flipped ?? false, aboveOverlay: display.aboveOverlay ?? false },
    }))
    setCharacterScales(prev => ({ ...prev, [char.id]: scale }))
  }

  // ── Campaign CRUD ─────────────────────────────────────────────
  async function updateCampaignCover(campId: string, file: File) {
    const camp = campaigns.find(c => c.id === campId)
    if (!camp || !userId) return
    try {
      if (camp.cover_path) await deleteMedia(supabase, camp.cover_path).catch(() => {})
      const path = await uploadMedia(supabase, userId, file)
      const { error } = await supabase.from('campaigns').update({ cover_path: path, cover_file_name: file.name }).eq('id', campId)
      if (error) throw error
      setCampaigns(prev => prev.map(c => c.id === campId
        ? { ...c, cover_path: path, cover_file_name: file.name, cover_signed_url: publicStorageUrl(path) }
        : c
      ))
    } catch {
      showError('Failed to upload cover image.')
    }
  }

  async function createCampaign() {
    if (!newCampName.trim()) return
    const { data, error } = await supabase.from('campaigns').insert({ name: newCampName.trim(), user_id: userId }).select('*').single()
    if (error) { showError('Failed to create campaign.'); return }
    if (data) { setCampaigns(prev => [...prev, data]); setActiveCampId(data.id); setNewCampName(''); setCampModalOpen(false) }
  }

  async function executeDeleteCampaign(campId: string) {
    const camp = campaigns.find(c => c.id === campId)
    if (!camp) return

    try {
      const { data: campScenes } = await supabase.from('scenes').select('id, bg, overlay').eq('campaign_id', campId)
      const sceneIds = (campScenes ?? []).map(s => s.id)

      // Collect handouts (both scene-scoped and campaign-scoped) BEFORE the
      // FK-CASCADE wipes them — otherwise their storage paths leak into the
      // bucket forever.
      type HandoutMediaRow = { media: { storage_path?: string | null } | null }
      const handoutsQuery = sceneIds.length
        ? supabase.from('handouts').select('media').or(`campaign_id.eq.${campId},scene_id.in.(${sceneIds.join(',')})`)
        : supabase.from('handouts').select('media').eq('campaign_id', campId)
      const [{ data: allTracks }, { data: allChars }, { data: allSounds }, { data: allHandouts }, { data: allOverlays }] = await Promise.all([
        sceneIds.length ? supabase.from('tracks').select('storage_path').in('scene_id', sceneIds) : Promise.resolve({ data: [] }),
        supabase.from('characters').select('storage_path').eq('campaign_id', campId),
        supabase.from('campaign_sounds').select('storage_path').eq('campaign_id', campId),
        handoutsQuery,
        sceneIds.length ? supabase.from('scene_overlays').select('storage_path').in('scene_id', sceneIds) : Promise.resolve({ data: [] }),
      ])

      // Delete DB rows first — orphan storage is cheaper than dangling rows
      if (sceneIds.length) {
        await supabase.from('scene_characters').delete().in('scene_id', sceneIds)
        await supabase.from('tracks').delete().in('scene_id', sceneIds)
      }
      await Promise.all([
        supabase.from('scenes').delete().eq('campaign_id', campId),
        supabase.from('characters').delete().eq('campaign_id', campId),
        supabase.from('sessions').delete().eq('campaign_id', campId),
        supabase.from('campaign_sounds').delete().eq('campaign_id', campId),
      ])
      await supabase.from('campaigns').delete().eq('id', campId)

      const storagePaths = [
        camp.cover_path,
        ...(campScenes ?? []).flatMap(s => [s.bg?.storage_path, s.overlay?.storage_path]),
        ...(allTracks ?? []).map((t: { storage_path?: string | null }) => t.storage_path),
        ...(allChars ?? []).map((c: { storage_path?: string | null }) => c.storage_path),
        ...(allSounds ?? []).map((s: { storage_path?: string | null }) => s.storage_path),
        ...((allHandouts ?? []) as HandoutMediaRow[]).map(h => h.media?.storage_path),
        ...((allOverlays ?? []) as { storage_path?: string | null }[]).map(o => o.storage_path),
      ].filter((p): p is string => !!p)
      await deleteMediaBatch(supabase, storagePaths).catch(() => {})

      setCampaigns(prev => prev.filter(c => c.id !== campId))
      if (activeCampId === campId) {
        setActiveCampId(''); setScenes([]); setIsLive(false); setSessionId(null); setJoinCode(null)
      }
    } catch {
      showError('Failed to delete campaign. Please try again.')
    }
  }

  function deleteCampaign() {
    if (!activeCampId || !activeCampaign) return
    openConfirm({
      title: 'Delete Campaign',
      body: `Delete "${activeCampaign.name}" and all its scenes? This cannot be undone.`,
      confirmLabel: 'Delete Campaign',
      onConfirm: () => executeDeleteCampaign(activeCampId),
    })
  }

  function deleteCampaignById(campId: string) {
    const camp = campaigns.find(c => c.id === campId)
    if (!camp) return
    openConfirm({
      title: 'Delete Campaign',
      body: `Delete "${camp.name}" and all its scenes? This cannot be undone.`,
      confirmLabel: 'Delete Campaign',
      onConfirm: () => executeDeleteCampaign(campId),
    })
  }

  async function createCharacter(name: string, file: File | null, url: string) {
    if (!activeCampId || !userId) return
    let storagePath: string | undefined
    let imageUrl: string | undefined
    try {
      if (file) {
        storagePath = await uploadMedia(supabase, userId, file)
      } else {
        imageUrl = url || undefined
      }
    } catch {
      showError('Failed to upload image. Please try again.')
      return
    }
    const { data, error } = await supabase.from('characters').insert({
      campaign_id:  activeCampId,
      name,
      url:          imageUrl || null,
      storage_path: storagePath || null,
      file_name:    file?.name || null,
    }).select('*').single()
    if (error) { showError('Failed to create character.'); return }
    if (data) {
      const [resolved] = resolveCharacterUrls([data as Character])
      setCampaignCharacters(prev => [...prev, resolved].sort((a, b) => a.name.localeCompare(b.name)))
    }
  }

  async function createCampaignTag(name: string, color: string) {
    if (!activeCampId) return
    const { data, error } = await supabase.from('campaign_tags').insert({ campaign_id: activeCampId, name, color }).select('*').single()
    if (error) { showError('Failed to create tag.'); return }
    if (data) setCampaignTags(prev => [...prev, data as CampaignTag].sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function deleteCampaignTag(tagId: string) {
    const affected = campaignCharacters.filter(c => c.tags?.includes(tagId))
    // Batch-update all affected characters in one round-trip via upsert
    if (affected.length) {
      const ok = await reportDbError(
        supabase.from('characters').upsert(
          affected.map(c => ({ id: c.id, tags: c.tags.filter(t => t !== tagId) })),
          { onConflict: 'id' }
        ),
        'Failed to remove tag from characters.',
      )
      if (!ok) return
    }
    const ok = await reportDbError(
      supabase.from('campaign_tags').delete().eq('id', tagId),
      'Failed to delete tag.',
    )
    if (!ok) return
    setCampaignTags(prev => prev.filter(t => t.id !== tagId))
    setCampaignCharacters(prev => prev.map(c => ({ ...c, tags: (c.tags ?? []).filter(t => t !== tagId) })))
  }

  async function updateCharacterTags(charId: string, tags: string[]) {
    const ok = await reportDbError(
      supabase.from('characters').update({ tags }).eq('id', charId),
      'Failed to update character tags.',
    )
    if (!ok) return
    setCampaignCharacters(prev => prev.map(c => c.id === charId ? { ...c, tags } : c))
  }

  async function updateCharacterName(charId: string, name: string) {
    const ok = await reportDbError(
      supabase.from('characters').update({ name }).eq('id', charId),
      'Failed to rename character.',
    )
    if (!ok) return
    setCampaignCharacters(prev => prev.map(c => c.id === charId ? { ...c, name } : c))
    setActiveCharacters(prev => ({
      left:   prev.left?.id   === charId ? { ...prev.left,   name } : prev.left,
      center: prev.center?.id === charId ? { ...prev.center, name } : prev.center,
      right:  prev.right?.id  === charId ? { ...prev.right,  name } : prev.right,
    }))
  }

  async function updateCharacterImagePosition(charId: string, x: number, y: number) {
    const ok = await reportDbError(
      supabase.from('characters').update({ image_x: x, image_y: y }).eq('id', charId),
      'Failed to save character framing.',
    )
    if (!ok) return
    setCampaignCharacters(prev => prev.map(c => c.id === charId ? { ...c, image_x: x, image_y: y } : c))
  }

  async function deleteCharacter(charId: string) {
    const char = campaignCharacters.find(c => c.id === charId)
    if (!char) return
    if (char.storage_path) await deleteMedia(supabase, char.storage_path).catch(() => {})
    const okJoin = await reportDbError(
      supabase.from('scene_characters').delete().eq('character_id', charId),
      'Failed to detach character from scenes.',
    )
    if (!okJoin) return
    const ok = await reportDbError(
      supabase.from('characters').delete().eq('id', charId),
      'Failed to delete character.',
    )
    if (!ok) return
    setCampaignCharacters(prev => prev.filter(c => c.id !== charId))
    // Clear character from any active stage slot
    setActiveCharacters(prev => ({
      left:   prev.left?.id   === charId ? null : prev.left,
      center: prev.center?.id === charId ? null : prev.center,
      right:  prev.right?.id  === charId ? null : prev.right,
    }))
  }

  async function updateCampaignName(campId: string, name: string) {
    const ok = await reportDbError(
      supabase.from('campaigns').update({ name }).eq('id', campId),
      'Failed to rename campaign.',
    )
    if (!ok) return
    setCampaigns(prev => prev.map(c => c.id === campId ? { ...c, name } : c))
  }

  async function updateCampaignDescription(campId: string, description: string) {
    const ok = await reportDbError(
      supabase.from('campaigns').update({ description }).eq('id', campId),
      'Failed to update campaign description.',
    )
    if (!ok) return
    setCampaigns(prev => prev.map(c => c.id === campId ? { ...c, description } : c))
  }

  async function updateCampaignCoverPosition(campId: string, x: number, y: number) {
    const ok = await reportDbError(
      supabase.from('campaigns').update({ cover_x: x, cover_y: y }).eq('id', campId),
      'Failed to save cover position.',
    )
    if (!ok) return
    setCampaigns(prev => prev.map(c => c.id === campId ? { ...c, cover_x: x, cover_y: y } : c))
  }

  async function signOut() { await supabase.auth.signOut(); window.location.href = '/login' }

  async function handleReorder(dragId: string, targetId: string) {
    const copy     = [...scenes]
    const fromIdx  = copy.findIndex(s => s.id === dragId)
    const toIdx    = copy.findIndex(s => s.id === targetId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    const [item]   = copy.splice(fromIdx, 1)
    copy.splice(toIdx, 0, item)
    const updated  = copy.map((s, i) => ({ ...s, order_index: i }))
    setScenes(updated)
    // Per-row UPDATE rather than upsert: scenes.campaign_id is NOT NULL,
    // and Postgres validates NOT NULL on the INSERT before ON CONFLICT
    // routing, so a partial-row upsert always errors out silently.
    await Promise.all(updated.map(s =>
      supabase.from('scenes').update({ order_index: s.order_index }).eq('id', s.id)
    ))
  }

  // ── Folder CRUD ───────────────────────────────────────────────
  async function handleFolderReorder(dragId: string, targetId: string) {
    const copy    = [...folders]
    const fromIdx = copy.findIndex(f => f.id === dragId)
    const toIdx   = copy.findIndex(f => f.id === targetId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    const [item] = copy.splice(fromIdx, 1)
    copy.splice(toIdx, 0, item)
    const updated = copy.map((f, i) => ({ ...f, order_index: i }))
    setFolders(updated)
    // See note in handleReorder — scene_folders.campaign_id is also NOT NULL.
    await Promise.all(updated.map(f =>
      supabase.from('scene_folders').update({ order_index: f.order_index }).eq('id', f.id)
    ))
  }

  async function createFolder(name: string) {
    if (!activeCampId) return
    const order_index = folders.length
    const { data, error } = await supabase.from('scene_folders')
      .insert({ campaign_id: activeCampId, name, order_index })
      .select().single()
    if (error) { showError('Failed to create folder.'); return }
    if (data) setFolders(prev => [...prev, data as SceneFolder])
  }

  async function renameFolder(id: string, name: string) {
    const ok = await reportDbError(
      supabase.from('scene_folders').update({ name }).eq('id', id),
      'Failed to rename folder.',
    )
    if (!ok) return
    setFolders(prev => prev.map(f => f.id === id ? { ...f, name } : f))
  }

  async function updateFolderColor(id: string, color: string) {
    setFolders(prev => prev.map(f => f.id === id ? { ...f, color } : f))
    await reportDbError(
      supabase.from('scene_folders').update({ color }).eq('id', id),
      'Failed to update folder color.',
    )
  }

  function deleteFolder(id: string) {
    const folder = folders.find(f => f.id === id)
    if (!folder) return
    openConfirm({
      title: 'Delete Folder',
      body: `Delete "${folder.name}"? Scenes inside will become unfiled.`,
      confirmLabel: 'Delete Folder',
      onConfirm: async () => {
        const { error } = await supabase.from('scene_folders').delete().eq('id', id)
        if (error) { showError('Failed to delete folder.'); return }
        setFolders(prev => prev.filter(f => f.id !== id))
        setScenes(prev => prev.map(s => s.folder_id === id ? { ...s, folder_id: null } : s))
      },
    })
  }

  async function moveSceneToFolder(sceneId: string, folderId: string | null) {
    const ok = await reportDbError(
      supabase.from('scenes').update({ folder_id: folderId }).eq('id', sceneId),
      'Failed to move scene.',
    )
    if (!ok) return
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, folder_id: folderId } : s))
  }

  async function executeSceneDelete(sc: Scene) {
    try {
      const { data: sceneTracks } = await supabase.from('tracks').select('storage_path').eq('scene_id', sc.id)
      // Delete DB rows first, then storage
      await supabase.from('scene_characters').delete().eq('scene_id', sc.id)
      await supabase.from('tracks').delete().eq('scene_id', sc.id)
      await supabase.from('scenes').delete().eq('id', sc.id)
      const storagePaths = [
        sc.bg?.storage_path,
        sc.overlay?.storage_path,
        ...(sceneTracks ?? []).map((t: { storage_path?: string | null }) => t.storage_path),
      ].filter((p): p is string => !!p)
      await deleteMediaBatch(supabase, storagePaths).catch(() => {})
    } catch {
      showError(`Failed to delete scene "${sc.name}".`)
    }
  }

  function deleteScene(id: string) {
    const idx = scenes.findIndex(s => s.id === id)
    const sc  = scenes[idx]
    if (!sc) return

    const insertAfterId = idx > 0 ? scenes[idx - 1].id : null

    // Remove from UI immediately
    setScenes(prev => prev.filter(s => s.id !== id))
    if (activeSceneId === id) setActiveSceneId('')

    // Schedule actual DB delete after 5 seconds
    const timer = setTimeout(() => {
      executeSceneDelete(sc)
      setPendingDeletes(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }, 5000)

    setPendingDeletes(prev => ({ ...prev, [id]: { scene: sc, insertAfterId, timer } }))
  }

  function undoDeleteScene(id: string) {
    const pending = pendingSceneDeletes[id]
    if (!pending) return

    clearTimeout(pending.timer)
    setPendingDeletes(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })

    // Re-insert the scene at its original position
    setScenes(prev => {
      if (!pending.insertAfterId) return [pending.scene, ...prev]
      const idx = prev.findIndex(s => s.id === pending.insertAfterId)
      if (idx === -1) return [...prev, pending.scene]
      return [...prev.slice(0, idx + 1), pending.scene, ...prev.slice(idx + 1)]
    })
  }

  function handleSceneSaved(saved: Scene, newCharacters: Character[] = []) {
    const isNew = !scenes.find(s => s.id === saved.id)
    const isSameScene = saved.id === activeSceneId
    const targetFolder = isNew ? newSceneFolderRef.current : null
    newSceneFolderRef.current = null
    setScenes(prev => { const e = prev.find(s => s.id === saved.id); return e ? prev.map(s => s.id === saved.id ? saved : s) : [...prev, { ...saved, folder_id: targetFolder }] })
    if (targetFolder) moveSceneToFolder(saved.id, targetFolder)
    handleSelectScene(saved.id)
    setEditorOpen(false)
    const [r] = resolveSceneUrls([saved])
    setScenes(prev => prev.map(s => s.id === r.id ? r : s))
    // Merge any new characters the editor created.
    if (newCharacters.length) {
      const resolved = resolveCharacterUrls(newCharacters)
      setCampaignCharacters(prev => {
        const existing = new Set(prev.map(c => c.id))
        const additions = resolved.filter(c => !existing.has(c.id))
        if (!additions.length) return prev
        return [...prev, ...additions].sort((a, b) => a.name.localeCompare(b.name))
      })
    }
    // If editing the active scene, roster/framing may have changed — refresh.
    // When switching scenes, the activeSceneId effect already loads the roster.
    if (isSameScene) loadSceneRoster(saved.id)
  }

  function copyUrl() {
    if (!viewerUrl) return
    navigator.clipboard?.writeText(viewerUrl)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  if (loading) return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', background: 'var(--bg)' }}>
      <div style={{ fontFamily: "'Cormorant Garamond',serif", fontSize: '22px', color: 'var(--accent)', letterSpacing: '2px' }}>Reverie</div>
      <div style={{ width: '160px', height: '3px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: 'var(--accent)', borderRadius: '2px', animation: 'loadBar 1.2s ease-in-out infinite' }} />
      </div>
      <style>{`@keyframes loadBar{0%{width:0%}50%{width:80%}100%{width:100%}}`}</style>
    </div>
  )

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── TOP BAR ── */}
      <div style={{ height: '46px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 10px', gap: '8px', flexShrink: 0, position: 'relative', zIndex: 10 }}>
        <div onClick={() => setActiveCampId('')} style={{ width: '28px', height: '28px', borderRadius: 'var(--r-sm)', background: 'var(--bg-raised)', border: '1px solid var(--border-lt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}><AppIcon size={20} /></div>
        <div onClick={() => setActiveCampId('')} className="topbar-title">
          {activeCampaign ? activeCampaign.name.toUpperCase() : 'REVERIE'}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          {activeCampId && !isLive && (
            <button className="btn btn-ghost btn-sm" onClick={startPresenting} title="Start Presenting" style={{ borderColor: 'rgba(74,158,101,0.5)', color: '#6ec48a', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg viewBox="0 0 10 12" xmlns="http://www.w3.org/2000/svg" width="8" height="10" style={{ flexShrink: 0 }}><polygon points="0,0 10,6 0,12" fill="currentColor"/></svg>
              <span className="topbar-label">Present</span>
            </button>
          )}
          {activeCampId && isLive && (
            <>
              <button onClick={() => setShareModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: '6px', padding: '4px 9px', cursor: 'pointer', color: 'var(--danger)', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--danger)', animation: 'livePulse 1.5s ease-in-out infinite', display: 'inline-block', flexShrink: 0 }} />
                LIVE<span className="topbar-label"> · {joinCode}</span>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={stopPresenting} title="Stop presenting" style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)', flexShrink: 0 }}>⏹</button>
            </>
          )}
          <SpotifyConnect />
          <button className="btn btn-ghost btn-sm" onClick={signOut} title="Sign out" style={{ flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6.5 1v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <path d="M9.5 2.8a5 5 0 1 1-6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── CAMPAIGN TAB BAR ── */}
      {activeCampId && (
        <div style={{ height: '38px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 14px', gap: '2px', flexShrink: 0 }}>
          {(['stage', 'characters'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setCampView(tab)}
              style={{
                padding: '5px 14px', border: 'none', borderRadius: '6px',
                background: campView === tab ? 'var(--bg-raised)' : 'transparent',
                color: campView === tab ? 'var(--text)' : 'var(--text-3)',
                cursor: 'pointer', fontSize: '11px', fontWeight: 700,
                letterSpacing: '1.5px', textTransform: 'uppercase',
                borderBottom: campView === tab ? '2px solid var(--accent)' : '2px solid transparent',
                transition: 'all 0.15s ease',
              }}
            >
              {tab === 'stage' ? 'Stage' : `Characters${campaignCharacters.length ? ` (${campaignCharacters.length})` : ''}`}
            </button>
          ))}
        </div>
      )}

      {/* ── WORKSPACE ── */}
      {!activeCampId ? (
        <CampaignHome
          campaigns={campaigns}
          onSelect={setActiveCampId}
          onNew={() => setCampModalOpen(true)}
          onUpdateCover={updateCampaignCover}
          onUpdateCoverPosition={updateCampaignCoverPosition}
          onUpdateName={updateCampaignName}
          onUpdateDescription={updateCampaignDescription}
          onDelete={deleteCampaignById}
        />
      ) : (
        <>
          {/* Stage and Characters tabs are both kept mounted to preserve the
              Spotify Web Playback SDK connection. Unmounting Stage calls
              player.disconnect(), which kills the virtual device — on remount
              the SDK sometimes fails to fire the `ready` event again, leaving
              music broken until a full page refresh. Toggling display:none keeps
              both trees alive while hiding the inactive view. */}
          <div style={{ flex: 1, display: campView === 'stage' ? 'flex' : 'none', overflow: 'hidden' }}>
            <Stage
              scene={activeScene}
              hasCampaign={!!activeCampId}
              onEdit={() => { setEditorSceneId(activeSceneId || null); setEditorOpen(true) }}
              spotify={spotify}
              characters={activeCharacters}
              slotScales={slotScales}
              slotDisplayProps={slotDisplayProps}
              campaignCharacters={sceneRosterChars}
              onCharactersChange={handleCharactersChange}
              onSlotDisplayChange={handleSlotDisplayChange}
              onSaveSlotDisplay={handleSaveSlotDisplay}
              onHandoutShow={handleHandoutShow}
              onMusicTrackChange={handleMusicTrackChange}
              isLive={isLive}
              activeOverlays={activeOverlays}
              onOverlayStateChange={handleOverlayStateChange}
              sounds={campaignSounds}
              campaignId={activeCampId}
              userId={userId}
              onSoundsChange={setCampaignSounds}
              onPlaySfx={handlePlaySfx}
              onStopSfx={handleStopSfx}
              campaignHandouts={campaignHandouts}
              onCampaignHandoutsChange={setCampaignHandouts}
            />
            {/* ── COLLAPSIBLE SCENE SIDEBAR ── */}
            <div style={{
              width: sidebarOpen ? '300px' : '36px',
              background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', flexShrink: 0,
              transition: 'width 0.2s ease', overflow: 'hidden',
            }}>
              {sidebarOpen ? (
                <>
                  {/* Open header */}
                  <div style={{ padding: '11px 12px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: '276px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--text-2)' }}>Scenes</span>
                      {scenes.length > 0 && (
                        <span style={{ fontSize: '9px', fontWeight: 700, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '10px', padding: '1px 7px', color: 'var(--text)' }}>{scenes.length}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      {/* New folder */}
                      <button
                        onClick={() => setCreateFolderOpen(true)}
                        title="New folder"
                        style={{
                          width: '24px', height: '24px', borderRadius: '6px',
                          background: 'var(--bg-raised)', border: '1px solid var(--border)',
                          color: 'var(--text-2)', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.12s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(139,159,232,0.5)'; e.currentTarget.style.color = 'var(--accent-2)'; e.currentTarget.style.background = 'rgba(139,159,232,0.06)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.background = 'var(--bg-raised)' }}
                      >
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                          <path d="M1 3.5C1 2.67 1.67 2 2.5 2h2.17a1 1 0 0 1 .71.29L6.09 3H10.5C11.33 3 12 3.67 12 4.5v5c0 .83-.67 1.5-1.5 1.5h-8C1.67 11 1 10.33 1 9.5v-6z" stroke="currentColor" strokeWidth="1.1"/>
                          <path d="M6.5 5.5v3M5 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                        </svg>
                      </button>
                      {/* New scene — opens folder picker if folders exist */}
                      <div style={{ position: 'relative' }}>
                        <button
                          onClick={() => {
                            if (folders.length > 0) { setFolderPickerOpen(p => !p) }
                            else { newSceneFolderRef.current = null; setEditorSceneId(null); setEditorOpen(true) }
                          }}
                          title="New scene"
                          style={{
                            width: '24px', height: '24px', borderRadius: '6px',
                            background: folderPickerOpen ? 'rgba(201,168,76,0.06)' : 'var(--bg-raised)',
                            border: `1px solid ${folderPickerOpen ? 'rgba(201,168,76,0.5)' : 'var(--border)'}`,
                            color: folderPickerOpen ? 'var(--accent)' : 'var(--text-2)', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', lineHeight: 1,
                            transition: 'all 0.12s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(201,168,76,0.5)'; e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'rgba(201,168,76,0.06)' }}
                          onMouseLeave={e => { if (!folderPickerOpen) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.background = 'var(--bg-raised)' } }}
                        >+</button>
                        {folderPickerOpen && (
                          <div
                            style={{
                              position: 'absolute', right: 0, top: '30px', zIndex: 200,
                              background: 'var(--bg-card, var(--bg-raised))', border: '1px solid var(--border)',
                              borderRadius: 'var(--r-lg)', padding: '4px', minWidth: '160px',
                              boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
                              animation: 'scenePickerIn 0.12s ease both',
                            }}
                            onMouseLeave={() => setFolderPickerOpen(false)}
                          >
                            <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--text-3)', padding: '4px 10px 2px' }}>Add scene to…</div>
                            {folders.map(f => (
                              <button
                                key={f.id}
                                onClick={() => { setFolderPickerOpen(false); newSceneFolderRef.current = f.id; setEditorSceneId(null); setEditorOpen(true) }}
                                style={{
                                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                                  padding: '6px 10px', borderRadius: '6px', border: 'none',
                                  background: 'transparent', color: 'var(--text-2)', cursor: 'pointer',
                                  fontSize: '11px', textAlign: 'left', transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                              >
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: f.color || 'var(--border-lt)', flexShrink: 0, display: 'inline-block', border: `1px solid ${f.color || 'var(--border)'}` }} />
                                {f.name}
                              </button>
                            ))}
                            <div style={{ height: '1px', background: 'var(--border)', margin: '3px 6px' }} />
                            <button
                              onClick={() => { setFolderPickerOpen(false); newSceneFolderRef.current = null; setEditorSceneId(null); setEditorOpen(true) }}
                              style={{
                                width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '6px 10px', borderRadius: '6px', border: 'none',
                                background: 'transparent', color: 'var(--text-3)', cursor: 'pointer',
                                fontSize: '11px', textAlign: 'left', transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                            >
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'transparent', flexShrink: 0, display: 'inline-block', border: '1px dashed var(--border-lt)' }} />
                              No folder
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Collapse sidebar */}
                      <button
                        onClick={() => setSidebarOpen(false)}
                        title="Collapse scenes"
                        style={{
                          width: '24px', height: '24px', borderRadius: '6px',
                          background: 'var(--bg-raised)', border: '1px solid var(--border)',
                          color: 'var(--text-2)', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '12px', transition: 'all 0.12s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-lt)'; e.currentTarget.style.color = 'var(--text)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-2)' }}
                      >▶</button>
                    </div>
                  </div>
                  <SceneList
                    key={activeCampId}
                    scenes={scenes}
                    folders={folders}
                    activeSceneId={activeSceneId}
                    hasCampaign={!!activeCampId}
                    onSelect={handleSelectScene}
                    onDelete={deleteScene}
                    onEdit={id => { setEditorSceneId(id); setEditorOpen(true) }}
                    onAdd={(folderId) => { newSceneFolderRef.current = folderId ?? null; setEditorSceneId(null); setEditorOpen(true) }}
                    onReorder={handleReorder}
                    onFolderReorder={handleFolderReorder}
                    createFolderOpen={createFolderOpen}
                    onCreateFolderOpenChange={setCreateFolderOpen}
                    onFolderCreate={createFolder}
                    onFolderRename={renameFolder}
                    onFolderDelete={deleteFolder}
                    onFolderColor={updateFolderColor}
                    onMoveToFolder={moveSceneToFolder}
                  />
                </>
              ) : (
                /* Collapsed strip — expand button */
                <button
                  onClick={() => setSidebarOpen(true)}
                  title="Show scenes"
                  style={{
                    width: '36px', height: '100%', border: 'none',
                    background: 'transparent', color: 'var(--text-3)',
                    cursor: 'pointer', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', paddingTop: '12px', gap: '10px',
                    transition: 'color 0.12s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-3)'}
                >
                  <span style={{ fontSize: '12px' }}>◀</span>
                  {scenes.length > 0 && (
                    <span style={{
                      fontSize: '9px', fontWeight: 700,
                      background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)',
                      borderRadius: '10px', padding: '2px 5px', color: 'var(--text-2)',
                    }}>{scenes.length}</span>
                  )}
                </button>
              )}
            </div>
          </div>

          <div style={{ flex: 1, display: campView === 'characters' ? 'flex' : 'none', overflow: 'hidden' }}>
            <CharacterRoster
              characters={campaignCharacters}
              campaignTags={campaignTags}
              onDelete={deleteCharacter}
              onAdd={createCharacter}
              onUpdateTags={updateCharacterTags}
              onUpdateName={updateCharacterName}
              onUpdateImagePosition={updateCharacterImagePosition}
              onCreateTag={createCampaignTag}
              onDeleteTag={deleteCampaignTag}
            />
          </div>
        </>
      )}

      {/* ── SCENE EDITOR ── */}
      {editorOpen && activeCampId && (
        <SceneEditor scene={editorScene} campaignId={activeCampId} userId={userId} campaignTags={campaignTags} onSave={handleSceneSaved} onClose={() => setEditorOpen(false)} />
      )}

      {/* ── SHARE / LIVE MODAL ── */}
      {shareModalOpen && joinCode && viewerUrl && (
        <ShareLiveModal
          joinCode={joinCode}
          viewerUrl={viewerUrl}
          qrUrl={qrUrl}
          copied={copied}
          onCopy={copyUrl}
          onClose={() => setShareModalOpen(false)}
          onStop={() => { stopPresenting(); setShareModalOpen(false) }}
        />
      )}

      {/* ── NEW CAMPAIGN MODAL ── */}
      {campModalOpen && (
        <NewCampaignModal
          value={newCampName}
          onChange={setNewCampName}
          onCreate={createCampaign}
          onClose={() => setCampModalOpen(false)}
        />
      )}

      {/* ── CONFIRM MODAL ── */}
      {confirmState && (
        <ConfirmModal
          title={confirmState.title}
          body={confirmState.body}
          confirmLabel={confirmState.confirmLabel}
          danger
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}

      {/* ── TOASTS (undo deletes + errors) ── */}
      {(Object.values(pendingSceneDeletes).length > 0 || toasts.length > 0) && (
        <div style={{
          position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
          display: 'flex', flexDirection: 'column', gap: '8px', zIndex: 9999,
          pointerEvents: 'none',
        }}>
          {Object.entries(pendingSceneDeletes).map(([id, p]) => (
            <div key={id} style={{
              background: 'var(--bg-raised)', border: '1px solid var(--border-lt)',
              borderRadius: '8px', padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: '12px',
              color: 'var(--text)', fontSize: '12px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              pointerEvents: 'all',
              animation: 'scenePickerIn 0.18s ease both',
            }}>
              <span style={{ color: 'var(--text-2)' }}>Scene &quot;{p.scene.name}&quot; deleted</span>
              <button className="btn btn-outline btn-sm" onClick={() => undoDeleteScene(id)}>Undo</button>
            </div>
          ))}
          {toasts.map(t => (
            <div key={t.id} style={{
              background: 'rgba(180,40,40,0.18)', border: '1px solid var(--danger-border)',
              borderRadius: '8px', padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: '10px',
              color: 'var(--text)', fontSize: '12px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              pointerEvents: 'all',
              animation: 'scenePickerIn 0.18s ease both',
            }}>
              <span style={{ color: 'var(--danger)', fontSize: '13px', flexShrink: 0 }}>✕</span>
              <span style={{ color: 'var(--text-2)' }}>{t.message}</span>
              <button
                onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '13px', cursor: 'pointer', padding: 0, flexShrink: 0, lineHeight: 1 }}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* ── HANDOUT LIGHTBOX ── */}
      {activeHandout && (
        <HandoutLightbox handout={activeHandout} onClose={() => { setActiveHandout(null); handleHandoutShow(null) }} />
      )}

      <style>{`@keyframes livePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}@keyframes scenePickerIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  )
}
