import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Roboto_Mono } from "next/font/google";

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Unit Calc",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={robotoMono.className} style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}

