import type { CoreDatabase } from "@media-marshal/media-core";
export function seedRecognitionReview(
  database: CoreDatabase,
  options?: { title?: string; tmdbId?: number; year?: number },
): string[];
export function seedScanIssue(database: CoreDatabase): string;
