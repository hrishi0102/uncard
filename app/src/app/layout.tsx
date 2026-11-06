import type { Metadata } from "next";
import { Bricolage_Grotesque, Spline_Sans_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const sans = Bricolage_Grotesque({ variable: "--font-sans", subsets: ["latin"], display: "swap" });
const receipt = Spline_Sans_Mono({ variable: "--font-receipt", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "AnyCheckout",
  description: "Your AI agent pays by card on any website. You pay in crypto, and only what was charged.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${receipt.variable} font-sans antialiased`}>
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
