import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";

/**
 * GET /api/auth/token
 *
 * Emite un JWT HS256 de corta duración para que el frontend pueda
 * autenticarse contra el backend FastAPI.
 *
 * Flujo:
 *  1. Valida la sesión NextAuth del usuario (Google OAuth).
 *  2. Si hay sesión activa, firma un JWT HS256 con NEXTAUTH_SECRET.
 *  3. El backend Python verifica el mismo secreto con python-jose.
 */
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.email) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "NEXTAUTH_SECRET no configurado" },
      { status: 500 }
    );
  }

  const encodedSecret = new TextEncoder().encode(secret);

  const token = await new SignJWT({
    email: session.user.email,
    name: session.user.name ?? "",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encodedSecret);

  return NextResponse.json({ token });
}
