/**
 * The numbers from the brief, in one place, imported by both the app and the
 * tests. The server restates them independently so a regression here fails
 * loudly instead of silently shipping a 20 MB file.
 */
export const LIMITS = {
  /** Hard ceiling at the destination. The app must never send more than this. */
  maxImageBytes: 5 * 1024 * 1024,
  minImages: 1,
  maxImages: 5,
  maxDescriptionChars: 2000,

  /**
   * Longest edge after resizing. 2560 px keeps a cracked weld or a serial
   * number legible, which is the entire point of the photograph -- "under the
   * ceiling" and "still worth looking at" are both requirements.
   */
  maxEdgePx: 2560,
  /** Smallest edge we will shrink to before giving up on the ceiling. */
  minEdgePx: 800,
  /** Quality ladder walked until the file fits. */
  qualityLadder: [88, 76, 64, 52, 42] as const,
  /** Local thumbnail, so a list of reports never loads 5 MB images to draw 64 px. */
  thumbEdgePx: 320,
  thumbQuality: 70,
} as const;

export const MIME_JPEG = 'image/jpeg';
