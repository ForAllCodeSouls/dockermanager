import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getPasswordHash } from "./store.js";

interface SessionPayload {
  sub: string;
  exp: number;
  iat: number;
}

function sign(data: string): string {
  return createHmac("sha256", config.secret).update(data).digest("base64url");
}

export function createToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: "admin",
    iat: now,
    exp: now + config.sessionMaxAgeSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    return payload.sub === "admin" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function tokenFromRequest(request: FastifyRequest): string | undefined {
  const cookie = request.cookies?.[config.cookieName];
  if (cookie) return cookie;
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

export function isAuthenticated(request: FastifyRequest): boolean {
  // agent 模式：用共享密钥的 Bearer Token 认证
  if (config.mode === "agent") {
    if (!config.agentToken) return false;
    const auth = request.headers.authorization;
    return auth === `Bearer ${config.agentToken}`;
  }
  return verifyToken(tokenFromRequest(request));
}

/** 校验来自主实例的 agent 请求（配置中登记的 token） */
export function isAgentRequest(request: FastifyRequest, token: string): boolean {
  if (!token) return false;
  const auth = request.headers.authorization;
  return auth === `Bearer ${token}`;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: config.sessionMaxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.cookieName, { path: "/" });
}

export async function verifyPassword(password: string): Promise<boolean> {
  const hash = getPasswordHash();
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function createDebugToken(minutes = 60): string {
  const payload = {
    scope: "diagnostics",
    exp: Math.floor(Date.now() / 1000) + minutes * 60,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyDebugToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as { scope: string; exp: number };
    return payload.scope === "diagnostics" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
