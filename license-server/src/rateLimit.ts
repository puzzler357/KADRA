/**
 * A fixed-window limit per client address (10.1: "На /v1/activate
 * ограничение частоты запросов"). In memory: one server process, and a
 * restart that forgets the counts costs an attacker nothing worth having.
 */

import type { NextFunction, Request, Response } from 'express';

export function rateLimit(options: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count++;

    if (hits.size > 10_000) {
      for (const [ip, value] of hits) if (value.resetAt <= now) hits.delete(ip);
    }

    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Слишком много запросов, повторите позже' });
      return;
    }
    next();
  };
}
