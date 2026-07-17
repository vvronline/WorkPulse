export type ChatMediaMetadata = Record<string, unknown> & {
  viewOnce?: boolean;
  viewedBy?: number[];
  width?: number;
  height?: number;
};

const MAX_MEDIA_DIMENSION = 100_000;

function validDimensionPair(
  widthValue: unknown,
  heightValue: unknown,
): { width: number; height: number } | null {
  const width = Number(widthValue);
  const height = Number(heightValue);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_MEDIA_DIMENSION ||
    height > MAX_MEDIA_DIMENSION
  ) {
    return null;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Build safe JSONB metadata from multipart chat-upload fields. */
export function buildUploadedMediaMetadata(input: {
  viewOnce?: unknown;
  width?: unknown;
  height?: unknown;
}): ChatMediaMetadata | null {
  const viewOnce = String(input.viewOnce || "") === "true";
  const dimensions = validDimensionPair(input.width, input.height);
  if (!viewOnce && !dimensions) return null;

  return {
    ...(viewOnce ? { viewOnce: true, viewedBy: [] as number[] } : {}),
    ...(dimensions || {}),
  };
}

/**
 * Preserve media presentation metadata when forwarding.
 *
 * Return a detached shallow copy so later view-once mutations on the original
 * message cannot mutate an in-memory forwarded payload.
 */
export function copyForwardedMediaMetadata(
  metadata: unknown,
): ChatMediaMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return { ...(metadata as ChatMediaMetadata) };
}