import { REPO_URL } from '@/lib/narrative'

export default function Nav() {
  return (
    // Not sticky: on a single scrolling story it would sit on top of the model in every close-up.
    <header className="absolute inset-x-0 top-0 z-10">
      <nav className="mx-auto flex h-16 max-w-content items-center justify-between px-6 wide:px-10">
        <a href="#top" className="text-[17px] font-semibold tracking-heading text-heading">
          Reconix
        </a>
        <div className="flex items-center gap-7 text-[15px] text-body">
          <a href="#map" className="hidden transition-colors hover:text-heading wide:inline">
            How it works
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-heading">
            GitHub
          </a>
        </div>
      </nav>
    </header>
  )
}
