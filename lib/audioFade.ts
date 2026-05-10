// Smooth audio crossfades for music-track switching. Without these,
// switching tracks during a live presentation does a hard pause + reset
// then a hard play, which sounds like a stutter — especially when the
// incoming track hasn't finished buffering yet.
//
// Used by both the viewer (the audio master during live) and the DM stage
// (for non-live local previewing).

const DEFAULT_FADE_MS = 500
const STEP_MS         = 25

export interface FadeHandle {
  cancel(): void
  /** Resolves when the fade completes — or immediately on cancel. */
  done: Promise<void>
}

/** Crossfade between two HTMLAudioElements. The outgoing element is paused
 *  and reset (currentTime=0) once the fade completes; its volume is restored
 *  so the next play starts at the user-set level. Either side can be null for
 *  a one-sided fade-in or fade-out.
 *
 *  The outgoing fade-out starts immediately (so the user hears something
 *  happen on click), but the incoming fade-in waits until the target audio
 *  reports HAVE_FUTURE_DATA / canplaythrough. Without that guard, calling
 *  `play()` on a partially-buffered audio element produces the "play→stall→
 *  play→stall" stutter that listeners hear as repeated pause/unpause. */
export function crossfadeAudio(
  from: HTMLAudioElement | null,
  to:   HTMLAudioElement | null,
  toVolume: number,
  durationMs = DEFAULT_FADE_MS,
): FadeHandle {
  const startFromVol = from?.volume ?? 0
  const steps = Math.max(1, Math.round(durationMs / STEP_MS))
  let cancelled = false
  let fromInterval: ReturnType<typeof setInterval> | null = null
  let toInterval:   ReturnType<typeof setInterval> | null = null
  let readyTimer:   ReturnType<typeof setTimeout>  | null = null
  let onReady: (() => void) | null = null
  let fromDone = !from
  let toDone   = !to
  let resolveDone!: () => void
  const done = new Promise<void>(res => { resolveDone = res })

  function maybeFinish() {
    if (fromDone && toDone) resolveDone()
  }

  // ── Outgoing: ramp volume to 0 then pause ─────────────────────
  if (from) {
    let fi = 0
    fromInterval = setInterval(() => {
      if (cancelled) return
      fi++
      const t = fi / steps
      from.volume = clamp01(startFromVol * (1 - t))
      if (fi >= steps) {
        if (fromInterval) clearInterval(fromInterval)
        fromInterval = null
        try {
          from.pause()
          // Only rewind if the track has actually finished. If the user
          // switched away mid-track, leave currentTime alone — switching
          // back resumes from where they paused, AND we avoid forcing a
          // seek-to-0 which on some browsers (esp. mobile) causes a fresh
          // byte-range fetch even though the data is already buffered.
          // That fetch is part of the "going back and forth is not smooth"
          // symptom.
          if (from.duration > 0 && from.currentTime >= from.duration - 0.5) {
            from.currentTime = 0
          }
        } catch {}
        from.volume = clamp01(startFromVol)
        fromDone = true
        maybeFinish()
      }
    }, STEP_MS)
  }

  // ── Incoming: wait until buffered, then ramp volume up ────────
  if (to) {
    to.volume = 0

    const startToFade = () => {
      if (cancelled) { toDone = true; maybeFinish(); return }
      if (to.paused) to.play().catch(() => {})
      let ti = 0
      toInterval = setInterval(() => {
        if (cancelled) return
        ti++
        const t = ti / steps
        to.volume = clamp01(toVolume * t)
        if (ti >= steps) {
          if (toInterval) clearInterval(toInterval)
          toInterval = null
          to.volume = clamp01(toVolume)
          toDone = true
          maybeFinish()
        }
      }, STEP_MS)
    }

    // Only HAVE_ENOUGH_DATA (readyState 4) is safe to play without buffer
    // underruns. HAVE_FUTURE_DATA (3) means "we have a tiny bit, enough to
    // play right now" — but the browser will run dry seconds later and
    // stall. The `canplaythrough` event fires when readyState reaches 4,
    // which is the same condition. (The previous code used `>= 3` and that
    // was the bug — listeners heard play→stall→play→stall, the "struggling
    // to fetch" symptom.)
    if (to.readyState >= 4) {
      startToFade()
    } else {
      onReady = () => {
        if (onReady && to) to.removeEventListener('canplaythrough', onReady)
        onReady = null
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
        startToFade()
      }
      to.addEventListener('canplaythrough', onReady)
      // 5s timeout for the worst case: file unreachable, network dead, or a
      // long file that keeps incrementally loading without ever reaching
      // canplaythrough. Better to attempt play and let the browser do its
      // best than to hang forever in silence.
      readyTimer = setTimeout(() => {
        if (onReady && to) to.removeEventListener('canplaythrough', onReady)
        onReady = null
        readyTimer = null
        startToFade()
      }, 5000)
    }
  }

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      if (fromInterval) clearInterval(fromInterval)
      if (toInterval)   clearInterval(toInterval)
      if (readyTimer)   clearTimeout(readyTimer)
      if (onReady && to) to.removeEventListener('canplaythrough', onReady)
      resolveDone()
    },
    done,
  }
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)) }
