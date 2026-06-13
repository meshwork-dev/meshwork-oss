import type { Metadata } from "next";
import "./globals.css";
import { OnboardingTour } from "@/components/tour/OnboardingTour";

export const metadata: Metadata = {
  title: "Meshwork Dashboard",
  description: "Runner monitoring and management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="theme-color" content="#14b8a6" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <OnboardingTour />
        {children}
      </body>
    </html>
  );
}
