/**
 * Prompt content from files (Node).
 *
 *   await agent.run(['Review this change', file('src/parse.ts'), image('screenshot.png')]);
 *
 * `file()` embeds a text file; an agent that cannot take embedded files gets
 * it as text instead (its path, then its contents). `image()` needs an agent
 * that takes images (`client.supports.prompt.image`).
 */
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentBlock } from './model.ts';

const TEXT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/x-toml',
};
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** A text file as prompt content. */
export function file(path: string, options: { mimeType?: string } = {}): ContentBlock {
  const full = resolve(path);
  return {
    type: 'resource',
    resource: {
      uri: pathToFileURL(full).href,
      mimeType: options.mimeType ?? TEXT_TYPES[extname(full).toLowerCase()] ?? 'text/plain',
      text: readFileSync(full, 'utf8'),
    },
  } as ContentBlock;
}

/** An image file as prompt content. */
export function image(path: string, options: { mimeType?: string } = {}): ContentBlock {
  const full = resolve(path);
  const mimeType = options.mimeType ?? IMAGE_TYPES[extname(full).toLowerCase()];
  if (!mimeType) throw new Error(`${path}: not a known image type (pass { mimeType })`);
  return { type: 'image', mimeType, data: readFileSync(full).toString('base64') } as ContentBlock;
}
