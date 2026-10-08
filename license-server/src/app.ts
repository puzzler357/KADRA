/**
 * HTTP surface of the licence server (5.2, 10.2).
 *
 * /v1/activate, /v1/refresh,   the KADRA client, authenticated by device signature
 * /v1/rebind, /v1/deactivate
 * /v1/payments/<source>        payment webhooks, signed with the source's secret
 * /v1/offline/*                offline request files, License Manager only
 * /admin                       the License Manager panel (static files)
 * /admin/api/*                 its JSON API: signed-in seller only
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { RuleError } from './core/rules.ts';
import { login, logout, sessionUser, SESSION_COOKIE, SESSION_MAX_AGE_MS } from './auth.ts';
import { rateLimit } from './rateLimit.ts';
import { createWebhookSource, handlePaymentWebhook, listWebhookSources, setWebhookSourceStatus } from './payments.ts';
import type { LicenseService } from './service.ts';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface AppOptions {
  /** Send the session cookie over HTTPS only. Off only for local development. */
  secureCookie?: boolean;
  /** Behind nginx or another reverse proxy: trust X-Forwarded-For for rate limits. */
  trustProxy?: boolean | number | string;
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** Express 5 forwards rejected promises and thrown errors to the error handler. */
type Handler = (req: Request, res: Response) => unknown;

export function createApp(service: LicenseService, options: AppOptions = {}) {
  const app = express();
  const secure = options.secureCookie ?? true;
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // The raw bytes are kept: a webhook signature covers exactly what was sent.
  app.use(express.json({
    limit: '64kb',
    verify: (req, _res, buffer) => { (req as Request & { rawBody?: Buffer }).rawBody = buffer; }
  }));

  const route = (method: 'get' | 'post' | 'patch', url: string, ...handlers: [...express.RequestHandler[], Handler]) => {
    const handler = handlers.pop() as Handler;
    app[method](url, ...(handlers as express.RequestHandler[]), async (req: Request, res: Response) => {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    });
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/', (_req, res) => res.redirect('/admin/'));
  app.use('/admin', express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  // ------------------------------------------------- the KADRA client (5.2)

  // Signed requests from KADRA itself: no session, the device signature is the
  // credential. Answers other than a signed file or status change nothing on
  // the client, so errors here are plain JSON.
  route('post', '/v1/activate', rateLimit({ name: 'activate', windowMs: 60 * 60_000, max: 20 }),
    req => service.activateOnline(req.body));
  route('post', '/v1/refresh', rateLimit({ name: 'refresh', windowMs: 60 * 60_000, max: 120 }),
    req => service.refreshOnline(req.body));
  route('post', '/v1/rebind', rateLimit({ name: 'rebind', windowMs: 60 * 60_000, max: 20 }),
    req => service.rebindOnline(req.body));
  route('post', '/v1/deactivate', rateLimit({ name: 'deactivate', windowMs: 60 * 60_000, max: 20 }),
    req => service.deactivateOnline(req.body));

  // --------------------------------------------- payment webhooks (stage 6)

  // Signed by the sender's own secret (src/payments.ts has the contract).
  route('post', '/v1/payments/:source', rateLimit({ name: 'payments', windowMs: 60_000, max: 120 }),
    req => handlePaymentWebhook(service, String(req.params.source),
      (req as Request & { rawBody?: Buffer }).rawBody, req.get('X-KDR-Signature')));

  // ------------------------------------------------------------ sign-in

  app.post('/admin/api/login', rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10 }), (req, res) => {
    const { username, password, code } = req.body ?? {};
    const token = login(service.db, String(username ?? ''), String(password ?? ''), String(code ?? ''));
    if (!token) {
      service.event(`login:${String(username ?? '')}`, 'LOGIN_FAILED', { ip: req.ip }, { severity: 'warning' });
      res.status(401).json({ error: 'LOGIN_FAILED', message: 'Неверное имя, пароль или код' });
      return;
    }
    service.event(`admin:${username}`, 'LOGIN', { ip: req.ip });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: SESSION_MAX_AGE_MS
    });
    res.json({ username });
  });

  // Everything else under /admin/api and the offline endpoints: a session,
  // and on writes a header a cross-site form cannot send.
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = sessionUser(service.db, cookie(req, SESSION_COOKIE));
    if (!user) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Требуется вход' });
      return;
    }
    if (req.method !== 'GET' && req.get('X-KDR-LM') !== '1') {
      res.status(403).json({ error: 'CSRF', message: 'Запрос отклонён' });
      return;
    }
    res.locals.actor = `admin:${user}`;
    res.locals.user = user;
    next();
  };
  app.use('/admin/api', requireAdmin);
  app.use('/v1/offline', requireAdmin, rateLimit({ name: 'offline', windowMs: 60_000, max: 60 }));

  const actor = (res: Response) => String(res.locals.actor);

  route('post', '/admin/api/logout', (req, res) => {
    logout(service.db, cookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  route('get', '/admin/api/me', (_req, res) => ({ username: res.locals.user }));
  route('get', '/admin/api/plans', () => service.plans());

  route('get', '/admin/api/customers', () => service.listCustomers());
  route('post', '/admin/api/customers', (req, res) => service.createCustomer(req.body ?? {}, actor(res)));
  route('patch', '/admin/api/customers/:id', (req, res) => service.updateCustomer(String(req.params.id), req.body ?? {}, actor(res)));

  route('get', '/admin/api/licenses', req =>
    service.listLicenses({ customer_id: typeof req.query.customer_id === 'string' ? req.query.customer_id : undefined }));
  route('post', '/admin/api/licenses', (req, res) => service.createLicense(req.body ?? {}, actor(res)));
  route('get', '/admin/api/licenses/:id', req => service.licenseDetails(String(req.params.id)));
  route('post', '/admin/api/licenses/:id/renew', (req, res) => service.renewLicense(String(req.params.id), req.body ?? {}, actor(res)));
  route('post', '/admin/api/licenses/:id/revoke', (req, res) =>
    service.revokeLicense(String(req.params.id), String(req.body?.reason ?? ''), actor(res)));

  route('post', '/admin/api/activations/:id/release', (req, res) => service.releaseActivation(String(req.params.id), actor(res)));
  route('post', '/admin/api/activations/:id/file', (req, res) => service.issueLicenseFile(String(req.params.id), actor(res)));
  route('post', '/admin/api/activations/:id/clear-fork', (req, res) =>
    service.clearForkSuspicion(String(req.params.id), actor(res)));
  route('post', '/admin/api/activations/:id/clock-reset', (req, res) =>
    service.issueClockReset(String(req.params.id), req.body?.high_water_to ?? null, actor(res)));

  route('get', '/admin/api/events', req => service.listEvents({
    severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
    license_id: typeof req.query.license_id === 'string' ? req.query.license_id : undefined,
    limit: Number(req.query.limit ?? 200)
  }));
  route('get', '/admin/api/suspicious', () => service.suspicious());

  route('get', '/admin/api/payments', () => service.listPayments());
  route('get', '/admin/api/webhook-sources', () => listWebhookSources(service.db));
  route('post', '/admin/api/webhook-sources', (req, res) =>
    createWebhookSource(service, String(req.body?.name ?? ''), actor(res)));
  route('post', '/admin/api/webhook-sources/:name/status', (req, res) => {
    setWebhookSourceStatus(service, String(req.params.name), req.body?.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED', actor(res));
    return listWebhookSources(service.db);
  });

  // ------------------------------------------------------ offline files (5.1)

  /** What a .kdrreq / .kdrdeact asks for; changes nothing. */
  route('post', '/v1/offline/inspect', (req, res) => service.inspectRequest(req.body?.request, {
    actor: actor(res),
    transferFrom: req.body?.transfer_from || undefined,
    overrideTransferLimit: Boolean(req.body?.override_transfer_limit),
    approveTransfer: Boolean(req.body?.approve_transfer)
  }));

  /** 5.2: applies it and returns the signed file, if the request produces one. */
  route('post', '/v1/offline/process', (req, res) => service.processRequest(req.body?.request, {
    actor: actor(res),
    transferFrom: req.body?.transfer_from || undefined,
    overrideTransferLimit: Boolean(req.body?.override_transfer_limit),
    approveTransfer: Boolean(req.body?.approve_transfer)
  }));

  app.use('/admin/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Нет такого метода' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RuleError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'BAD_JSON', message: 'Тело запроса — не JSON' });
      return;
    }
    console.error('[license-server]', error);
    res.status(500).json({ error: 'INTERNAL', message: 'Внутренняя ошибка сервера' });
  });

  return app;
}
