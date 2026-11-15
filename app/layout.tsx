import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apple Liquidity Lab",
  description: "Compare Apple tokenized-equity buy and sell liquidity across five issuers using verified Uniswap and Aerodrome pools.",
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
