"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const PERSONAS = [
  { id: "owner", label: "Me, the account owner", note: "Orb verified" },
  { id: "stranger", label: "Someone else", note: "Orb verified, different person" },
  { id: "unverified", label: "An unverified World account", note: "No Orb or Selfie Check" },
] as const;

function Device() {
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [persona, setPersona] = useState<(typeof PERSONAS)[number]["id"]>("owner");
  const [state, setState] = useState<"idle" | "found" | "missing" | "approved" | "denied">("idle");

  useEffect(() => {
    if (!code) return;
    fetch(`/api/mock-world/device/lookup?user_code=${encodeURIComponent(code)}`).then((r) => setState(r.ok ? "found" : "missing"));
  }, [code]);

  const decide = async (decision: "approve" | "deny") => {
    const res = await fetch("/api/mock-world/device/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: code, decision, persona }),
    });
    setState(res.ok ? (decision === "approve" ? "approved" : "denied") : "missing");
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-[#1c1d22] px-4 py-10">
      <div className="w-full max-w-[360px] rounded-[2.2rem] border-8 border-black bg-white p-6 shadow-2xl">
        <p className="text-center text-xs text-neutral-500">Simulated World App for local demos. The real flow uses World App and auth.world.org.</p>
        <div className="mx-auto mt-6 grid h-14 w-14 place-items-center rounded-full bg-black text-2xl text-white">◎</div>
        <h1 className="mt-4 text-center text-xl font-semibold">AnyCheckout wants to verify you</h1>

        {state === "approved" && <p className="mt-6 text-center text-lg font-medium">Verified. You can go back to AnyCheckout.</p>}
        {state === "denied" && <p className="mt-6 text-center text-lg font-medium">Cancelled. AnyCheckout was told no.</p>}
        {state === "missing" && <p className="mt-6 text-center text-red-600">This code is unknown or expired.</p>}

        {(state === "idle" || state === "found") && (
          <>
            <label className="mt-6 block text-sm text-neutral-600" htmlFor="code">Code shown on AnyCheckout</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-center font-mono text-lg tracking-widest" />
            <fieldset className="mt-5 space-y-2">
              <legend className="text-sm text-neutral-600">Who is approving?</legend>
              {PERSONAS.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${persona === p.id ? "border-black" : "border-neutral-200"}`}>
                  <input type="radio" name="persona" className="mt-1" checked={persona === p.id} onChange={() => setPersona(p.id)} />
                  <span>
                    <span className="block text-sm font-medium">{p.label}</span>
                    <span className="block text-xs text-neutral-500">{p.note}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button disabled={state !== "found"} onClick={() => decide("approve")} className="mt-6 w-full rounded-full bg-black py-3 font-medium text-white disabled:opacity-40">
              Approve with Face Auth
            </button>
            <button disabled={state !== "found"} onClick={() => decide("deny")} className="mt-2 w-full rounded-full py-3 font-medium text-neutral-700 disabled:opacity-40">
              Cancel
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Device />
    </Suspense>
  );
}
