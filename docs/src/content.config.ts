import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

// The guides live in docs/src/ so they also read as Markdown on GitHub.
// Front matter is optional: the title falls back to the first `# heading` (see src/nav.ts).
const guides = defineCollection({
  loader: glob({
    base: './src',
    pattern: ['*.md', '!README.md', '!README.pl.md', '!SECURITY.md', '!UPSTREAM.md', '!publishing-ghcr.md'],
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
})

export const collections = { guides }
