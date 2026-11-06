import Link from "next/link";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-[var(--taxi)] text-[var(--ink)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M3 10h18" />
          <path d="M7 15h3" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-[1.05rem]">AnyCheckout</span>
    </Link>
  );
}

export function SiteHeader({ right }: { right?: React.ReactNode }) {
  return (
    <header className="border-b border-[var(--hairline)] bg-[var(--paper)]">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Wordmark />
        <nav className="flex items-center gap-5 text-sm text-[var(--muted-foreground)]">
          <Link className="hover:text-[var(--ink)]" href="/dashboard">
            Dashboard
          </Link>
          <Link className="hover:text-[var(--ink)]" href="/shop">
            Demo shops
          </Link>
          <Link className="hidden hover:text-[var(--ink)] sm:inline" href="/#how">
            How it works
          </Link>
          {right}
        </nav>
      </div>
      <div className="taxi-stripe" />
    </header>
  );
}
