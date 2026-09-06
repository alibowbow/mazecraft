const SCALES = [1, 0.85, 0.7, 0.6] as const

/** Graphics-only feedback. Isolated stalls are ignored; recovery needs sustained headroom. */
export class RenderPerformanceBudget {
  private level = 0
  private elapsed = 0
  private frames = 0
  private fastWindows = 0
  private longFrames = 0
  get scale(): number { return SCALES[this.level] }

  observe(frameMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false
    if (frameMs > 250) {
      // A one-off GC/pause must not resize the canvas. Repeated sub-4fps
      // frames are sustained overload, however, and must not be ignored forever.
      if (++this.longFrames < 3) return false
      this.longFrames = 0
      this.elapsed = 0; this.frames = 0; this.fastWindows = 0
      if (this.level < SCALES.length - 1) { this.level++; return true }
      return false
    }
    this.longFrames = 0
    this.elapsed += frameMs
    this.frames++
    if (this.elapsed < 750 || this.frames < 8) return false
    const average = this.elapsed / this.frames
    this.elapsed = 0; this.frames = 0
    if (average > 27) {
      this.fastWindows = 0
      if (this.level < SCALES.length - 1) { this.level++; return true }
    } else if (average < 18) {
      if (++this.fastWindows >= 8 && this.level > 0) {
        this.fastWindows = 0; this.level--; return true
      }
    } else this.fastWindows = 0
    return false
  }
}
