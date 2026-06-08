import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "worthline",
  description: "Local-first net worth dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
