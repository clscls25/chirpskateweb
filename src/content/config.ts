import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().optional().default('Chirp Skate'),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { posts };
