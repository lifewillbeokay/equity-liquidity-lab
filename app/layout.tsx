import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Equity Liquidity Lab",
  description: "Compare tokenized-equity buy and sell simulations across issuers, chains and DEX routes.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
