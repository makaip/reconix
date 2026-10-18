import type { Beat } from '@/lib/narrative'
import { REPO_URL } from '@/lib/narrative'
import { ButtonLink } from '@/components/ui/button'

// Every beat uses the same frame: one viewport tall, copy in the left column on wide screens,
// at the bottom over a solid backing on narrow ones (where the model sits above it).
function Frame({ id, side = 'left', children }: { id: string; side?: Beat['side']; children: React.ReactNode }) {
  return (
    <section id={id} className="relative flex min-h-[100svh] items-end wide:items-center">
      <div className="mx-auto w-full max-w-content px-0 wide:px-10">
        <div
          className={`bg-page/95 px-6 pb-10 pt-6 wide:max-w-[min(31rem,36vw)] wide:bg-transparent wide:p-0 ${
            side === 'right' ? 'wide:ml-auto' : ''
          }`}
        >
          {children}
        </div>
      </div>
    </section>
  )
}

function Details({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-8 border-t border-hairline">
      {items.map((item) => (
        <li key={item} className="border-b border-hairline py-3 text-[15px] text-quiet">
          {item}
        </li>
      ))}
    </ul>
  )
}

export function Intro({ beat }: { beat: Beat }) {
  return (
    <Frame id={beat.id}>
      <h1 className="text-[clamp(2.75rem,5.6vw,5.25rem)] font-semibold leading-[0.95] tracking-display text-heading">
        {beat.title}
      </h1>
      <p className="mt-6 max-w-[28rem] text-[clamp(1.05rem,1.35vw,1.2rem)] leading-[1.55] text-body">{beat.body}</p>
      <div className="mt-9 flex items-center gap-7">
        <ButtonLink href={REPO_URL} target="_blank" rel="noreferrer">
          View on GitHub
        </ButtonLink>
        <ButtonLink href="#map" variant="link" size="inline">
          How it works
        </ButtonLink>
      </div>
    </Frame>
  )
}

export function Step({ beat }: { beat: Beat }) {
  return (
    <Frame id={beat.id} side={beat.side}>
      <h2 className="text-[clamp(1.9rem,3vw,2.75rem)] font-semibold leading-[1.05] tracking-heading text-heading">
        {beat.title}
      </h2>
      <p className="mt-5 text-[17px] leading-[1.6] text-body">{beat.body}</p>
      <Details items={beat.details} />
    </Frame>
  )
}

export function Outro({ beat }: { beat: Beat }) {
  return (
    <section id={beat.id} className="relative flex min-h-[100svh] flex-col">
      <div className="flex flex-1 items-end wide:items-center">
        <div className="mx-auto w-full max-w-content px-0 wide:px-10">
          <div className="bg-page/95 px-6 pb-10 pt-6 wide:max-w-[min(31rem,36vw)] wide:bg-transparent wide:p-0">
            <h2 className="text-[clamp(2.25rem,4vw,3.5rem)] font-semibold leading-[1] tracking-display text-heading">
              {beat.title}
            </h2>
            <p className="mt-5 text-[17px] leading-[1.6] text-body">{beat.body}</p>
            <div className="mt-9">
              <ButtonLink href={REPO_URL} target="_blank" rel="noreferrer">
                View on GitHub
              </ButtonLink>
            </div>
          </div>
        </div>
      </div>
      <footer className="bg-page wide:bg-transparent">
        <div className="mx-auto max-w-content px-6 wide:px-10">
          <div className="flex items-center justify-between border-t border-hairline py-6 text-[14px] text-quiet">
            <span>Reconix, MIT licensed</span>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-heading">
              github.com/makaip/reconix
            </a>
          </div>
        </div>
      </footer>
    </section>
  )
}
