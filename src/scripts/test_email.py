#!/usr/bin/env python3
"""
test_email.py — Send a one-off Resend test invite to verify delivery.

Usage:
  .\\venv\\Scripts\\python.exe src/scripts/test_email.py your@email.com
"""
import sys
from pathlib import Path

# Add project root to sys.path so src imports work
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import os
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import resend

TO = sys.argv[1] if len(sys.argv) > 1 else "vera.sierra27@gmail.com"
API_KEY = os.getenv("RESEND_API_KEY", "")
FROM    = os.getenv("EMAIL_FROM", "onboarding@resend.dev")

if not API_KEY:
    print("ERROR: RESEND_API_KEY not set in .env")
    sys.exit(1)

resend.api_key = API_KEY

print(f"Sending test invite to: {TO}")
print(f"From: {FROM}")
print(f"API key: {API_KEY[:8]}...{API_KEY[-4:]}")
print()

try:
    resp = resend.Emails.send({
        "from":    FROM,
        "to":      [TO],
        "subject": "[Cometa Vault] Test — Invitación de acceso",
        "html": """
        <div style="background:#0A0A0A;color:#EDEDED;font-family:Helvetica,sans-serif;
                    max-width:520px;margin:0 auto;padding:40px 32px;border-radius:8px;">
          <p style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;
                    color:#555;margin:0 0 24px;">Cometa Vault · Test</p>
          <h2 style="font-size:20px;font-weight:600;margin:0 0 16px;color:#EDEDED;">
            Correo de prueba — Sistema activo
          </h2>
          <p style="color:#A3A3A3;font-size:14px;line-height:1.6;">
            Este es un correo de prueba para confirmar que el sistema de invitaciones
            Resend está correctamente configurado y operativo.
          </p>
          <hr style="border:none;border-top:1px solid #222;margin:32px 0;" />
          <p style="color:#555;font-size:11px;margin:0;">
            Cometa VC · cometa.vc
          </p>
        </div>
        """,
    })
    print(f"[OK] Resend 200 — email_id: {resp.get('id') or resp}")
except Exception as exc:
    print(f"[FAIL] Resend ({type(exc).__name__}): {exc}")
    body = getattr(exc, "response", None) or getattr(exc, "body", None)
    if body:
        print(f"   response body: {body}")
    sys.exit(1)
