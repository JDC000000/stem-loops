import { z } from 'zod';

export const STEMS = ['drums', 'bass', 'vocals', 'guitar', 'keys', 'other'] as const;
export const LOOP_LENGTH_BARS = [1, 2, 4, 8] as const;
// Mirrors apps/worker/src/worker/models.py YOUTUBE_RE — keep the two in lockstep.
export const YOUTUBE_RE = /^https:\/\/(www\.youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}/;

export const JobRequestSchema = z.object({
  youtube_url: z.string().regex(YOUTUBE_RE, 'Not a valid YouTube URL'),
  requested_stems: z.array(z.enum(STEMS)).min(1),
  loop_length_bars: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
});

export type JobRequestInput = z.infer<typeof JobRequestSchema>;
