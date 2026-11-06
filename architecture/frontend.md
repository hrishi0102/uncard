# Frontend

Next.js 15 App Router, React 19, Tailwind v4, shadcn (base-nova), sonner for toasts. Pages live in `app/src/app/`.

## Pages

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/dashboard` | The user's view: vault balance, weekly allowance, every checkout as a receipt, MCP URL and agent key to copy. Polls `/api/dashboard` every 2 seconds. Demo controls (set policy, deposit, abandon a checkout) only show on the local chain |
| `/approve/[id]` | The approval page the agent hands to the human: QR and link to World App, then approve or deny |
| `/mock-world/device` | Simulated World App for mock mode, with owner, stranger and unverified personas |
| `/shop`, `/shop/[slug]`, `/shop/[slug]/checkout` | The three demo stores. Cart in `localStorage`. Checkout is a normal card form |
| `/topup` | Any-token top-up and Arc deposit with a browser wallet |

## Shared pieces

- `components/brand.tsx`: wordmark and site header.
- `components/receipt.tsx`: the receipt card and status stamp.
- `lib/format.ts`: money and time formatting.
- `app/globals.css`: color tokens, `.receipt` with a torn edge (CSS mask), `.money`, `.stamp`, `.taxi-stripe`, the print-in animation.

## Design

- **Receipt metaphor.** Every checkout reads as a printed receipt with three lines: Locked, Charged, Returned. That is the whole product in one picture.
- **Mumbai taxi palette:** ground `#e9ebe7`, carbon `#2b2f8c`, taxi `#ffc400`, stop `#c8233a`, go `#0b8a5f`.
- **Fonts:** Bricolage Grotesque for text, Spline Sans Mono for money and ids.
- **Demo shops look like ordinary stores**, not like AnyCheckout, so the demo shows the agent paying somewhere it does not control.

## Decisions

- **Polling instead of websockets.** Simple, and the 2 second delay is fine for a demo.
- **Checkout fields have labels, `autocomplete` and `aria-label`.** Browser agents find fields through the accessibility tree.
