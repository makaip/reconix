import type { Config } from 'tailwindcss'

// See DESIGN.md. Page colors are intentionally few; the model carries the app's own palette.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#0b0b0c',
        heading: '#f2f2f3',
        body: '#b7b7be',
        quiet: '#8a8a92',
        hairline: '#26262a'
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif']
      },
      letterSpacing: {
        display: '-0.035em',
        heading: '-0.025em'
      },
      maxWidth: { content: '1280px' },
      // Side-by-side layout (copy left, model right). Must match isWide() in components/scene/Rig.tsx.
      screens: { wide: { raw: '(min-aspect-ratio: 9/10) and (min-width: 768px)' } }
    }
  },
  plugins: []
}
export default config
