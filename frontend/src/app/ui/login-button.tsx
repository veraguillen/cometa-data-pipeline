"use client";

import { signIn } from "next-auth/react";

export default function LoginButton() {
  return (
    <button
      type="button"
      onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
      className="group flex w-full items-center justify-center gap-3 rounded-full border border-white/15 bg-black/40 px-6 py-3 text-sm font-normal text-white transition-colors hover:border-[rgba(100,202,228,0.65)] hover:bg-black/55"
    >
      <span className="h-2 w-2 rounded-full bg-[rgba(100,202,228,0.95)] shadow-[0_0_24px_rgba(100,202,228,0.65)]" />
      <span>Ingresar con Google</span>
      <span className="ml-auto text-white/60 transition-colors group-hover:text-[rgba(100,202,228,0.95)]">
        →
      </span>
    </button>
  );
}
