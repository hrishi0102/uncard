"use client";

import { useCallback, useEffect, useState } from "react";

export type CartItem = { sku: string; qty: number };

const key = (slug: string) => `anycheckout-demo-cart:${slug}`;

function readCart(slug: string): CartItem[] {
  try {
    return JSON.parse(localStorage.getItem(key(slug)) ?? "[]");
  } catch {
    return [];
  }
}

export function useCart(slug: string) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setItems(readCart(slug));
    setReady(true);
  }, [slug]);

  const save = useCallback(
    (next: CartItem[]) => {
      setItems(next);
      try {
        localStorage.setItem(key(slug), JSON.stringify(next));
      } catch {
        // private mode: cart lives only in memory
      }
    },
    [slug],
  );

  const add = (sku: string) => {
    const cur = readCart(slug);
    const found = cur.find((i) => i.sku === sku);
    save(found ? cur.map((i) => (i.sku === sku ? { ...i, qty: i.qty + 1 } : i)) : [...cur, { sku, qty: 1 }]);
  };
  const setQty = (sku: string, qty: number) => save(readCart(slug).map((i) => (i.sku === sku ? { ...i, qty } : i)).filter((i) => i.qty > 0));
  const clear = () => save([]);

  return { items, ready, add, setQty, clear };
}
