import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

// Public SIWC OAuth endpoints, documented for locally hosted personal/OSS apps.
export const AUTH_ORIGIN = 'https://auth.openai.com';
export const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
export const JWKS_URL = `${AUTH_ORIGIN}/.well-known/jwks.json`;
export const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
export const API_RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', statusCode = 502, requestId } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.statusCode = statusCode;
    if (requestId) this.requestId = requestId;
  }
}

export function abortError() {
  return new DOMException('Yêu cầu đã được dừng.', 'AbortError');
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validHostId(value) {
  return typeof value === 'string' && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function newHostId() { return `urn:uuid:${randomUUID()}`; }

async function jsonBody(response, maxBytes = 1024 * 1024) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new ProviderError('Phản hồi xác thực vượt quá kích thước cho phép.', { code: 'auth_response_too_large' });
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ProviderError('Dịch vụ xác thực trả về dữ liệu không hợp lệ.', { code: 'auth_invalid_json' }); }
  } finally { await reader.cancel().catch(() => {}); }
}

/** One explicitly selected ChatGPT account; never borrows Codex/browser cookies. */
export class ChatGPTAuth {
  constructor({ hostId, saved = {}, persist, fetchImpl = fetch, registerSecret = () => {}, now = Date.now, appName = 'ChatMCP Local Hub' }) {
    if (!validHostId(hostId)) throw new Error('Host ID ChatGPT không hợp lệ.');
    this.hostId = hostId;
    this.data = { ...saved };
    this.persist = persist;
    this.fetch = fetchImpl;
    this.registerSecret = registerSecret;
    this.now = now;
    this.appName = appName;
    this.pending = null;
    this.refreshing = null;
    this.jwks = null;
    this.jwksAt = 0;
    this.generation = 0;
    this.loggingOut = false;
    this.persistenceError = false;
    this.registerTokens(this.data);
  }

  registerTokens(data) {
    for (const key of ['accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token', 'id_token']) {
      if (typeof data?.[key] === 'string') this.registerSecret(data[key]);
    }
  }

  state() {
    return {
      signedIn: !!this.data.idToken && !!this.data.subject,
      planEnabled: !!this.data.accessToken && (this.data.scopes ?? []).includes(PLAN_SCOPE),
      email: this.data.email ?? '',
      loginPending: !!this.pending && this.pending.expiresAt > this.now(),
      clientRegistered: !!this.data.clientId,
    };
  }

  ready() {
    return !this.loggingOut && !this.persistenceError && this.state().planEnabled && (!!this.data.refreshToken || this.data.expiresAt > this.now());
  }

  async commit(next) {
    // Keep a rotated token in memory even if disk encryption fails; never replay
    // the superseded refresh token. Surface the persistence failure to the UI.
    this.registerTokens(next);
    this.data = { ...next };
    try { await this.persist(this.data); this.persistenceError = false; }
    catch (error) { this.persistenceError = true; throw error; }
  }

  beginLogin({ baseUrl }) {
    if (this.loggingOut) throw new ProviderError('Đang đăng xuất kết nối ChatGPT.', { code: 'auth_busy', statusCode: 409 });
    let base;
    try { base = new URL(baseUrl); } catch { throw new ProviderError('Địa chỉ callback không hợp lệ.', { code: 'invalid_callback', statusCode: 400 }); }
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
      throw new ProviderError('Đăng nhập ChatGPT cần callback HTTP tại 127.0.0.1 của ứng dụng này.', { code: 'invalid_callback', statusCode: 400 });
    }
    const redirectUri = new URL('/auth/chatgpt/callback', base.origin).href;
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    for (const secret of [verifier, state, nonce]) this.registerSecret(secret);
    this.pending = { verifier, state, nonce, redirectUri, expiresAt: this.now() + 10 * 60_000, clientId: this.data.clientId || null, expectedSubject: this.data.subject || null, generation: this.generation };
    const url = new URL(AUTHORIZE_URL);
    const parameters = {
      client_id: this.data.clientId || 'dynamic_agent_client',
      ext_agent_host_id: this.hostId,
      response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES.join(' '), resource: API_RESOURCE,
      state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    if (!this.data.clientId) parameters.agent_name_hint = this.appName;
    else {
      if (this.data.idToken) parameters.id_token_hint = this.data.idToken;
      if (this.data.email) parameters.login_hint = this.data.email;
      // Only this explicit button requests plan consent again after a decline.
      if (!(this.data.scopes ?? []).includes(PLAN_SCOPE)) parameters.prompt = 'consent';
    }
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    return { url: url.href };
  }

  async requestToken(parameters, signal) {
    let response;
    try {
      response = await this.fetch(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(parameters), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new ProviderError('Không kết nối được dịch vụ đăng nhập ChatGPT. Có thể thử lại sau.', { code: 'auth_network_error' });
    }
    const data = await jsonBody(response);
    this.registerTokens(data);
    if (!response.ok || data.error) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code || 'oauth_error';
      const text = code === 'invalid_grant' ? 'Phiên đăng nhập hoặc mã xác thực đã hết hiệu lực. Bấm đăng nhập lại.' : code === 'invalid_client' ? 'Client đăng nhập ChatGPT không hợp lệ.' : 'Dịch vụ ChatGPT chưa chấp nhận yêu cầu xác thực.';
      throw new ProviderError(text, { code, statusCode: response.status >= 400 ? response.status : 401, requestId: response.headers.get('x-request-id') || undefined });
    }
    return data;
  }

  async getKeys(force = false) {
    if (!force && this.jwks && this.now() - this.jwksAt < 15 * 60_000) return this.jwks;
    let response;
    try { response = await this.fetch(JWKS_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new ProviderError('Chưa xác minh được chữ ký đăng nhập ChatGPT.', { code: 'jwks_unavailable' }); }
    if (!response.ok) throw new ProviderError('Chưa tải được khóa xác minh đăng nhập ChatGPT.', { code: 'jwks_unavailable' });
    const data = await jsonBody(response);
    if (!Array.isArray(data.keys) || data.keys.length > 100) throw new ProviderError('Khóa xác minh ChatGPT không hợp lệ.', { code: 'invalid_jwks' });
    this.jwks = data.keys;
    this.jwksAt = this.now();
    return this.jwks;
  }

  async verifyIdentity(token, { clientId, nonce, expectedSubject } = {}) {
    const invalid = () => new ProviderError('Không xác minh được danh tính đăng nhập ChatGPT. Hãy đăng nhập lại.', { code: 'invalid_id_token', statusCode: 401 });
    if (typeof token !== 'string' || token.length > 100_000) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw invalid();
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw invalid(); }
    if (!['RS256', 'ES256', 'EdDSA'].includes(header.alg) || typeof header.kid !== 'string') throw invalid();
    let keys = await this.getKeys();
    let jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
    if (!jwk) { keys = await this.getKeys(true); jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig')); }
    if (!jwk || ({ RS256: 'RSA', ES256: 'EC', EdDSA: 'OKP' })[header.alg] !== jwk.kty) throw invalid();
    let signatureValid = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      signatureValid = verify(header.alg === 'EdDSA' ? null : 'sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
    } catch { throw invalid(); }
    const seconds = this.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!signatureValid || claims.iss !== AUTH_ORIGIN || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= seconds || (claims.nbf && claims.nbf > seconds + 60) || (claims.iat && claims.iat > seconds + 60) || typeof claims.sub !== 'string' || !claims.sub) throw invalid();
    if (nonce !== undefined && !equal(claims.nonce, nonce)) throw invalid();
    if (expectedSubject && !equal(claims.sub, expectedSubject)) throw new ProviderError('Tài khoản trả về khác với kết nối đã chọn. Thông tin đăng nhập cũ được giữ nguyên.', { code: 'account_mismatch', statusCode: 401 });
    return { subject: claims.sub, issuer: claims.iss, email: typeof claims.email === 'string' ? claims.email.slice(0,320) : '' };
  }

  tokenRecord(data, previous, identity) {
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous.scopes || [];
    if (!scopes.includes(PLAN_SCOPE)) {
      // Identity-only consent is a valid sign-in, but never enables inference.
      return { clientId: previous.clientId, ...identity, idToken: data.id_token || previous.idToken, scopes, ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}), savedAt: this.now() };
    }
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || String(data.token_type).toLowerCase() !== 'bearer') {
      throw new ProviderError('ChatGPT trả về bộ token không đầy đủ. Hãy đăng nhập lại.', { code: 'incomplete_token_response', statusCode: 401 });
    }
    return { ...previous, ...identity, accessToken: data.access_token, refreshToken: data.refresh_token, idToken: data.id_token || previous.idToken, scopes, expiresAt: this.now() + data.expires_in * 1000, savedAt: this.now() };
  }

  async completeLogin(parameters) {
    const params = parameters instanceof URLSearchParams ? parameters : new URLSearchParams(parameters);
    const attempt = this.pending;
    if (!attempt || attempt.expiresAt <= this.now()) { this.pending = null; throw new ProviderError('Lần đăng nhập đã hết thời gian. Bấm đăng nhập lại.', { code: 'login_expired', statusCode: 400 }); }
    if (params.getAll('state').length !== 1 || !equal(params.get('state'), attempt.state)) throw new ProviderError('Callback đăng nhập không khớp phiên đã mở.', { code: 'invalid_oauth_state', statusCode: 400 });
    this.pending = null; // A matching callback is single-use, including denial.
    if (params.has('error')) throw new ProviderError(params.get('error') === 'access_denied' ? 'Bạn đã hủy hoặc chưa đồng ý kết nối ChatGPT.' : 'Đăng nhập ChatGPT chưa hoàn tất.', { code: params.get('error') === 'access_denied' ? 'access_denied' : 'oauth_callback_error', statusCode: 400 });
    if (params.getAll('code').length !== 1 || !params.get('code')) throw new ProviderError('Callback thiếu mã xác thực.', { code: 'missing_auth_code', statusCode: 400 });
    if (params.getAll('client_id').length > 1) throw new ProviderError('Callback có client ID không hợp lệ.', { code: 'invalid_client', statusCode: 400 });
    const receivedClientId = params.get('client_id');
    const clientId = attempt.clientId || receivedClientId;
    if (!clientId || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]{8,200}$/.test(clientId) || (attempt.clientId && receivedClientId && attempt.clientId !== receivedClientId)) throw new ProviderError('Client ID đăng nhập không khớp. Kết nối cũ được giữ nguyên.', { code: 'invalid_client', statusCode: 400 });
    const code = params.get('code');
    this.registerSecret(code);
    // Save a new issued ID before exchange so an expired authorization code does
    // not create another agent registration on the next sign-in.
    if (!attempt.clientId) await this.commit({ ...this.data, clientId });
    const data = await this.requestToken({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: API_RESOURCE });
    const identity = await this.verifyIdentity(data.id_token, { clientId, nonce: attempt.nonce, expectedSubject: attempt.expectedSubject });
    if (attempt.generation !== this.generation) throw new ProviderError('Kết nối đã được đăng xuất trong lúc xác thực.', { code: 'login_cancelled', statusCode: 409 });
    const record = this.tokenRecord(data, { ...this.data, clientId }, identity);
    await this.commit(record);
    return this.state();
  }

  async accessToken(signal) {
    if (signal?.aborted) throw abortError();
    if (this.loggingOut) throw new ProviderError('Đang đăng xuất kết nối ChatGPT.', { code: 'auth_busy', statusCode: 409 });
    if (this.persistenceError) throw new ProviderError('Chưa lưu được thông tin đăng nhập an toàn trên Windows. Hãy kiểm tra kết nối và đăng nhập lại.', { code: 'credential_persistence_failed' });
    if (!this.state().planEnabled) throw new ProviderError('Hãy đăng nhập và cho phép dùng gói ChatGPT trước.', { code: 'chatgpt_plan_not_enabled', statusCode: 401 });
    if (this.data.expiresAt > this.now() + 60_000) return this.data.accessToken;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    // A user stopping one generation must not interrupt shared token rotation.
    const token = await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      this.refreshing.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
    });
    if (signal?.aborted) throw abortError();
    return token;
  }

  async refresh() {
    const prior = { ...this.data };
    const generation = this.generation;
    if (!prior.refreshToken || !prior.clientId) throw new ProviderError('Kết nối ChatGPT đã hết hạn. Hãy đăng nhập lại.', { code: 'login_required', statusCode: 401 });
    let data;
    try { data = await this.requestToken({ grant_type: 'refresh_token', client_id: prior.clientId, refresh_token: prior.refreshToken, resource: API_RESOURCE }); }
    catch (error) {
      if (TERMINAL_REFRESH_ERRORS.has(error.code) && generation === this.generation) await this.commit({ clientId: prior.clientId, subject: prior.subject, issuer: prior.issuer, email: prior.email });
      throw error;
    }
    const identity = data.id_token ? await this.verifyIdentity(data.id_token, { clientId: prior.clientId, expectedSubject: prior.subject }) : {};
    if (generation !== this.generation && !this.loggingOut) throw new ProviderError('Kết nối đã được đăng xuất.', { code: 'login_cancelled', statusCode: 409 });
    await this.commit(this.tokenRecord(data, prior, identity));
    if (this.loggingOut || generation !== this.generation) throw new ProviderError('Kết nối đã được đăng xuất.', { code: 'login_cancelled', statusCode: 409 });
    return this.data.accessToken;
  }

  async logout() {
    this.pending = null;
    this.loggingOut = true;
    this.generation += 1;
    // A refresh may already have rotated its token server-side. Let it retain the
    // latest replacement, then revoke that token rather than an obsolete one.
    if (this.refreshing) await this.refreshing.catch(() => {});
    const prior = { ...this.data };
    let revoked = !prior.refreshToken;
    let revocationError;
    if (prior.refreshToken && prior.clientId) {
      try {
        const discoveryResponse = await this.fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(10_000) });
        if (!discoveryResponse.ok) throw new Error('Discovery unavailable');
        const discovery = await jsonBody(discoveryResponse);
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== AUTH_ORIGIN || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Untrusted revocation endpoint');
        const response = await this.fetch(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: prior.refreshToken, token_type_hint: 'refresh_token', client_id: prior.clientId }), signal: AbortSignal.timeout(15_000) });
        revoked = response.status === 200;
        await response.body?.cancel().catch(() => {});
      } catch { revoked = false; }
      if (!revoked) revocationError = 'Đã đăng xuất trên máy này; chưa xác nhận thu hồi phiên trên OpenAI. Có thể ngắt app tại ChatGPT Settings → Security and login → Sign in with ChatGPT.';
    }
    try { await this.commit({ clientId: prior.clientId, subject: prior.subject, issuer: prior.issuer, email: prior.email }); }
    finally { this.loggingOut = false; }
    return { revoked, revocationError };
  }
}
