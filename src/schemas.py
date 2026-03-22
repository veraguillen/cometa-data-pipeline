"""
schemas.py — Pydantic models for Cometa Pipeline.

Responsabilidades:
  - Fuente única de verdad para la forma de los datos en el backend.
  - Toda entidad que se persiste o se expone por API debe tener un modelo aquí.
  - UserSchema es la puerta obligatoria antes de cualquier escritura en users.json:
    _save_users() SOLO acepta list[UserSchema], lo que hace imposible persistir
    datos sin validar a nivel de firma de función.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, EmailStr, field_validator

# ── Constantes de validación ───────────────────────────────────────────────────
HYBRID_ID_PATTERN: str   = r"^(ANA|FND)-[A-Za-z0-9]{6}$"
HYBRID_ID_RE: re.Pattern = re.compile(HYBRID_ID_PATTERN)

UserRole = Literal["ANALISTA", "FOUNDER", "SOCIO"]


# ── Modelos de persistencia (users.json) ──────────────────────────────────────

class StoredUser(BaseModel):
    """
    Representación permisiva de un usuario leído desde users.json.
    Acepta IDs legacy (e.g. 'U001') para no romper lecturas antes de la migración.
    Solo se usa en _load_users() — nunca para escritura.
    """
    id:         str
    email:      EmailStr
    password:   str
    name:       str  = ""
    role:       str  = "FOUNDER"
    company_id: str  = ""
    status:     str  = "ACTIVE"   # ACTIVE | PENDING_INVITE


class UserSchema(BaseModel):
    """
    Contrato de escritura: única representación que _save_users() acepta.

    Invariantes garantizadas en construcción:
      - id       → formato ^(ANA|FND)-[A-Za-z0-9]{6}$ (ID Híbrido válido)
      - email    → dirección válida según RFC 5322, normalizada a minúscula
      - role     → uno de ANALISTA | FOUNDER | SOCIO
      - password → presente y no vacío
      - status   → ACTIVE | PENDING_INVITE (default ACTIVE)

    Al requerir list[UserSchema] como firma de _save_users(), es imposible
    llamar esa función con datos sin validar — el error ocurre en construcción,
    antes de que se abra cualquier archivo.
    """
    id:         str
    email:      EmailStr
    password:   str
    name:       str      = ""
    role:       UserRole = "FOUNDER"
    company_id: str      = ""
    status:     str      = "ACTIVE"

    @field_validator("id")
    @classmethod
    def id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v

    @field_validator("email", mode="before")
    @classmethod
    def email_to_lowercase(cls, v: str) -> str:
        return str(v).strip().lower()

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("password no puede estar vacío")
        return v


# Alias backward-compatible — código existente que importa UserOut sigue funcionando
UserOut = UserSchema


# ── Modelos de respuesta de API ───────────────────────────────────────────────

class UserPublic(BaseModel):
    """
    Datos del usuario que se exponen en /api/login y /api/me.
    No incluye password ni campos internos de almacenamiento.
    """
    user_id:    str
    email:      EmailStr
    name:       str      = ""
    role:       UserRole
    company_id: str      = ""

    @field_validator("user_id")
    @classmethod
    def user_id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v


class LoginApiResponse(BaseModel):
    """Forma completa de la respuesta de POST /api/login."""
    access_token: str
    token_type:   str
    user:         UserPublic


class MeApiResponse(BaseModel):
    """Forma completa de la respuesta de GET /api/me."""
    user_id:    str
    email:      EmailStr
    name:       str      = ""
    role:       UserRole
    company_id: str      = ""

    @field_validator("user_id")
    @classmethod
    def user_id_must_be_hybrid(cls, v: str) -> str:
        if not HYBRID_ID_RE.match(v):
            raise ValueError(
                f"user_id '{v}' no cumple el formato ^(ANA|FND)-[A-Za-z0-9]{{6}}$"
            )
        return v
