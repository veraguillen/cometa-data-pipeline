import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cometa Vault",
  description: "Portal de Inversión — Cometa VC",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
