import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
/** Prefix an asset in /public so it resolves under the GitHub Pages project base path. */
export const asset = (p: string) => `${BASE}${p.startsWith('/') ? p : `/${p}`}`
