/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import vscode from 'vscode';
import { log } from '../common/logging';
import { AssignmentManager } from '../jupyter/assignments';
import {
  AgentBridgeRequest,
  dispatchAgentBridgeRequest,
} from './agent-bridge-rpc';

const BRIDGE_ENDPOINT = '/v1/colab-agent';
const BRIDGE_HEALTH_ENDPOINT = '/healthz';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const LOCALHOST_HOST = 'localhost';
const IPV6_LOOPBACK_HOST = '::1';
const IPV6_UNSPECIFIED_HOST = '::';
const IPV4_UNSPECIFIED_HOST = '0.0.0.0';
const LOOPBACK_V4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/;

interface AgentBridgeConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly allowRemoteHost: boolean;
  readonly stateFile: string;
}

interface AgentBridgeStateFile {
  readonly version: 1;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly tokenRequired: boolean;
  readonly pid: number;
  readonly startedAt: string;
}

interface AgentBridgeErrorResponse {
  readonly id?: string | number;
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly code?: string;
    readonly message: string;
  };
}

interface AgentBridgeSuccessResponse {
  readonly id?: string | number;
  readonly ok: true;
  readonly result: unknown;
}

interface AgentBridgeServerIdentity {
  readonly pid: number;
  readonly port: number;
}

interface AgentBridgeLockIdentity {
  readonly pid: number;
  readonly instanceId: string;
}

interface AgentBridgeLockFile {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

class HttpRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorResponse(
  error: unknown,
  id?: string | number,
): AgentBridgeErrorResponse {
  if (error instanceof Error) {
    const errorCode =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    return {
      id,
      ok: false,
      error: {
        name: error.name,
        code: errorCode,
        message: error.message,
      },
    };
  }
  return {
    id,
    ok: false,
    error: {
      name: 'Error',
      message: String(error),
    },
  };
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: AgentBridgeErrorResponse | AgentBridgeSuccessResponse,
): void {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

function resolveStateFilePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function resolveLockFilePath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  if (
    normalizedHost === LOCALHOST_HOST ||
    normalizedHost === IPV6_LOOPBACK_HOST
  ) {
    return true;
  }
  if (!LOOPBACK_V4_HOST_PATTERN.test(normalizedHost)) {
    return false;
  }
  return normalizedHost
    .split('.')
    .map(Number)
    .every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        (index > 0 || octet === 127),
    );
}

function isWildcardBindHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === IPV4_UNSPECIFIED_HOST ||
    normalizedHost === IPV6_UNSPECIFIED_HOST
  );
}

function formatHostForEndpoint(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parseRequestPath(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = getHeader(req, 'content-type');
  if (!contentType) {
    return false;
  }
  const [mimeType] = contentType.split(';', 1);
  return mimeType.trim().toLowerCase() === 'application/json';
}

function parseStateFileIdentity(
  value: unknown,
): AgentBridgeServerIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pid = value.pid;
  const port = value.port;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof port !== 'number' ||
    !Number.isInteger(port)
  ) {
    return undefined;
  }
  return { pid, port };
}

function parseLockFileIdentity(
  value: unknown,
): AgentBridgeLockIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pid = value.pid;
  const instanceId = value.instanceId;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof instanceId !== 'string' ||
    instanceId.trim().length === 0
  ) {
    return undefined;
  }
  return { pid, instanceId };
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrorWithCode(error, 'EPERM');
  }
}

function readConfig(vs: typeof vscode): AgentBridgeConfig {
  const config = vs.workspace.getConfiguration('colab.agentBridge');

  const enabled = config.get<boolean>('enabled', false);
  const rawHost = config.get<string>('host', DEFAULT_HOST).trim();
  const host = rawHost.length > 0 ? rawHost : DEFAULT_HOST;
  const rawPort = config.get<number>('port', DEFAULT_PORT);
  const port =
    Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535
      ? rawPort
      : DEFAULT_PORT;
  const token = config.get<string>('token', '').trim();
  const allowRemoteHost = config.get<boolean>('allowRemoteHost', false);
  const rawStateFile = config.get<string>('stateFile', DEFAULT_STATE_FILE);
  const stateFile = resolveStateFilePath(rawStateFile.trim());

  return {
    enabled,
    host,
    port,
    token,
    allowRemoteHost,
    stateFile,
  };
}

function configsEqual(a?: AgentBridgeConfig, b?: AgentBridgeConfig): boolean {
  if (!a || !b) {
    return false;
  }
  return (
    a.enabled === b.enabled &&
    a.host === b.host &&
    a.port === b.port &&
    a.token === b.token &&
    a.allowRemoteHost === b.allowRemoteHost &&
    a.stateFile === b.stateFile
  );
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(
          new HttpRequestError(
            'PAYLOAD_TOO_LARGE',
            413,
            'Request body exceeds 1 MiB limit.',
          ),
        );
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (rejected) {
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(
          new HttpRequestError(
            'INVALID_JSON',
            400,
            'Request body must be valid JSON.',
          ),
        );
      }
    });

    req.on('error', (error) => {
      if (rejected) {
        return;
      }
      reject(error);
    });
  });
}

function parseRequest(body: unknown): AgentBridgeRequest {
  if (!isRecord(body)) {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request body must be a JSON object.',
    );
  }

  const method = body.method;
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request "method" must be a non-empty string.',
    );
  }

  const id = body.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request "id" must be a string or number.',
    );
  }

  return {
    id,
    method,
    params: body.params,
  };
}

function getHeader(
  req: http.IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isAuthorizedRequest(
  req: http.IncomingMessage,
  config: AgentBridgeConfig,
): boolean {
  if (config.token.length === 0) {
    return false;
  }

  const authHeader = getHeader(req, 'authorization');
  if (authHeader === `Bearer ${config.token}`) {
    return true;
  }

  const tokenHeader = getHeader(req, 'x-colab-agent-token');
  return tokenHeader === config.token;
}

async function writeStateFile(
  stateFilePath: string,
  state: AgentBridgeStateFile,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  await fs.writeFile(
    stateFilePath,
    `${JSON.stringify(state, undefined, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  // Keep the discovery file readable only by the local user when possible.
  try {
    await fs.chmod(stateFilePath, 0o600);
  } catch (_error) {
    // Best-effort on platforms without chmod support.
  }
}

async function removeStateFile(
  stateFilePath: string,
  expectedIdentity: AgentBridgeServerIdentity,
): Promise<void> {
  let shouldRemove = false;
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const identity = parseStateFileIdentity(parsed);
    shouldRemove =
      identity !== undefined &&
      identity.pid === expectedIdentity.pid &&
      identity.port === expectedIdentity.port;
  } catch (error: unknown) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return;
    }
    log.warn(`Unable to inspect agent bridge state file: ${stateFilePath}`, error);
    return;
  }

  if (!shouldRemove) {
    return;
  }

  try {
    await fs.rm(stateFilePath, { force: true });
  } catch (error: unknown) {
    log.warn(`Unable to remove agent bridge state file: ${stateFilePath}`, error);
  }
}

async function acquireBridgeLock(
  lockFilePath: string,
  identity: AgentBridgeLockIdentity,
): Promise<boolean> {
  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFilePath, 'wx', 0o600);
      try {
        const lockFile: AgentBridgeLockFile = {
          pid: identity.pid,
          instanceId: identity.instanceId,
          startedAt: new Date().toISOString(),
        };
        await handle.writeFile(
          `${JSON.stringify(lockFile, undefined, 2)}\n`,
          'utf8',
        );
      } finally {
        await handle.close();
      }
      try {
        await fs.chmod(lockFilePath, 0o600);
      } catch (_error) {
        // Best-effort on platforms without chmod support.
      }
      return true;
    } catch (error: unknown) {
      if (!isErrorWithCode(error, 'EEXIST')) {
        throw error;
      }
    }

    let staleLock = true;
    try {
      const raw = await fs.readFile(lockFilePath, 'utf8');
      const parsed = parseLockFileIdentity(JSON.parse(raw) as unknown);
      if (
        parsed &&
        parsed.pid === identity.pid &&
        parsed.instanceId === identity.instanceId
      ) {
        return true;
      }
      staleLock = !parsed || !isProcessRunning(parsed.pid);
    } catch (error: unknown) {
      if (isErrorWithCode(error, 'ENOENT')) {
        continue;
      }
      staleLock = true;
    }

    if (!staleLock) {
      return false;
    }

    try {
      await fs.rm(lockFilePath, { force: true });
    } catch (_error) {
      return false;
    }
  }

  return false;
}

async function releaseBridgeLock(
  lockFilePath: string,
  expectedIdentity: AgentBridgeLockIdentity,
): Promise<void> {
  let shouldRemove = false;
  try {
    const raw = await fs.readFile(lockFilePath, 'utf8');
    const parsed = parseLockFileIdentity(JSON.parse(raw) as unknown);
    shouldRemove =
      parsed !== undefined &&
      parsed.pid === expectedIdentity.pid &&
      parsed.instanceId === expectedIdentity.instanceId;
  } catch (error: unknown) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return;
    }
    log.warn(`Unable to inspect agent bridge lock file: ${lockFilePath}`, error);
    return;
  }

  if (!shouldRemove) {
    return;
  }

  try {
    await fs.rm(lockFilePath, { force: true });
  } catch (error: unknown) {
    log.warn(`Unable to remove agent bridge lock file: ${lockFilePath}`, error);
  }
}

export class AgentBridgeController implements vscode.Disposable {
  private readonly configListener: vscode.Disposable;
  private readonly lockIdentity: AgentBridgeLockIdentity;
  private refreshQueue: Promise<void> = Promise.resolve();
  private isDisposed = false;
  private activeConfig?: AgentBridgeConfig;
  private activeStateIdentity?: AgentBridgeServerIdentity;
  private activeLockFilePath?: string;
  private server?: http.Server;

  constructor(
    private readonly vs: typeof vscode,
    private readonly assignmentManager: AssignmentManager,
  ) {
    this.lockIdentity = {
      pid: process.pid,
      instanceId: randomUUID(),
    };
    this.configListener = vs.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('colab.agentBridge')) {
        this.scheduleRefresh();
      }
    });
    this.scheduleRefresh();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.configListener.dispose();
    this.refreshQueue = this.refreshQueue
      .then(() => this.stopServer())
      .catch((error) => {
        log.error('Error while stopping agent bridge during dispose.', error);
      });
  }

  private scheduleRefresh(): void {
    this.refreshQueue = this.refreshQueue
      .then(async () => {
        if (this.isDisposed) {
          return;
        }
        await this.applyConfig();
      })
      .catch((error) => {
        log.error('Error while refreshing agent bridge configuration.', error);
      });
  }

  private async applyConfig(): Promise<void> {
    const nextConfig = readConfig(this.vs);
    if (!nextConfig.enabled) {
      await this.stopServer();
      return;
    }

    if (isWildcardBindHost(nextConfig.host)) {
      await this.stopServer();
      log.error(
        `Agent bridge host "${nextConfig.host}" is not supported. Use a specific loopback or interface address.`,
      );
      void this.vs.window.showErrorMessage(
        `Colab agent bridge host "${nextConfig.host}" is not supported.`,
      );
      return;
    }

    if (nextConfig.token.length === 0) {
      await this.stopServer();
      log.error(
        'Agent bridge is enabled but colab.agentBridge.token is empty. Refusing to start.',
      );
      void this.vs.window.showErrorMessage(
        'Colab agent bridge requires colab.agentBridge.token when enabled.',
      );
      return;
    }

    if (!nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
      await this.stopServer();
      log.error(
        `Agent bridge host "${nextConfig.host}" is not loopback. Set colab.agentBridge.allowRemoteHost=true only if you understand the security risks.`,
      );
      void this.vs.window.showErrorMessage(
        `Colab agent bridge host "${nextConfig.host}" is blocked because it is not loopback.`,
      );
      return;
    }

    if (nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
      log.warn(
        `Agent bridge is listening on non-loopback host "${nextConfig.host}".`,
      );
    }

    if (this.server && configsEqual(this.activeConfig, nextConfig)) {
      return;
    }

    await this.stopServer();
    await this.startServer(nextConfig);
  }

  private async startServer(config: AgentBridgeConfig): Promise<void> {
    const lockFilePath = resolveLockFilePath(config.stateFile);
    const lockAcquired = await acquireBridgeLock(lockFilePath, this.lockIdentity);
    if (!lockAcquired) {
      log.warn(
        `Agent bridge lock is held by another process (${lockFilePath}); skipping start.`,
      );
      return;
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, config);
    });
    // Notebook execution can exceed the default HTTP server request timeout.
    server.requestTimeout = 0;
    server.headersTimeout = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await releaseBridgeLock(lockFilePath, this.lockIdentity);
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
      await releaseBridgeLock(lockFilePath, this.lockIdentity);
      throw new Error('Failed to determine agent bridge listening address.');
    }

    this.server = server;
    this.activeConfig = config;
    this.activeStateIdentity = {
      pid: process.pid,
      port: address.port,
    };
    this.activeLockFilePath = lockFilePath;

    const endpointHost = formatHostForEndpoint(config.host);
    const endpoint = `http://${endpointHost}:${address.port.toString()}${BRIDGE_ENDPOINT}`;
    log.info(`Agent bridge listening at ${endpoint}`);

    try {
      await writeStateFile(config.stateFile, {
        version: 1,
        host: config.host,
        port: address.port,
        endpoint,
        tokenRequired: config.token.length > 0,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.server = undefined;
      this.activeConfig = undefined;
      this.activeStateIdentity = undefined;
      this.activeLockFilePath = undefined;
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((_closeError) => {
          resolve();
        });
      });
      await releaseBridgeLock(lockFilePath, this.lockIdentity);
      throw error;
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    const stateFilePath = this.activeConfig?.stateFile;
    const stateIdentity = this.activeStateIdentity;
    const lockFilePath = this.activeLockFilePath;
    this.server = undefined;
    this.activeConfig = undefined;
    this.activeStateIdentity = undefined;
    this.activeLockFilePath = undefined;

    if (server) {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((_error) => {
          resolve();
        });
      });
    }

    if (stateFilePath && stateIdentity) {
      await removeStateFile(stateFilePath, stateIdentity);
    }

    if (lockFilePath) {
      await releaseBridgeLock(lockFilePath, this.lockIdentity);
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: AgentBridgeConfig,
  ): Promise<void> {
    req.setTimeout(0);
    res.setTimeout(0);
    const requestPath = parseRequestPath(req.url);

    if (requestPath === BRIDGE_HEALTH_ENDPOINT && req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        result: {
          status: 'ok',
        },
      });
      return;
    }

    if (requestPath !== BRIDGE_ENDPOINT) {
      writeJson(res, 404, {
        ok: false,
        error: {
          name: 'NotFoundError',
          code: 'NOT_FOUND',
          message: `Unknown endpoint "${req.url ?? ''}".`,
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, {
        ok: false,
        error: {
          name: 'MethodNotAllowedError',
          code: 'METHOD_NOT_ALLOWED',
          message: 'Use POST for bridge requests.',
        },
      });
      return;
    }

    if (!hasJsonContentType(req)) {
      writeJson(res, 415, {
        ok: false,
        error: {
          name: 'UnsupportedMediaTypeError',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Requests must use Content-Type: application/json.',
        },
      });
      return;
    }

    if (!isAuthorizedRequest(req, config)) {
      writeJson(res, 401, {
        ok: false,
        error: {
          name: 'UnauthorizedError',
          code: 'UNAUTHORIZED',
          message:
            'Missing or invalid token. Use Authorization: Bearer <token>.',
        },
      });
      return;
    }

    let request: AgentBridgeRequest;
    try {
      request = parseRequest(await readRequestBody(req));
    } catch (error: unknown) {
      const statusCode =
        error instanceof HttpRequestError ? error.statusCode : 400;
      writeJson(res, statusCode, toErrorResponse(error));
      return;
    }

    try {
      const result = await dispatchAgentBridgeRequest(
        this.assignmentManager,
        request,
      );
      writeJson(res, 200, {
        id: request.id,
        ok: true,
        result,
      });
    } catch (error: unknown) {
      writeJson(res, 200, toErrorResponse(error, request.id));
    }
  }
}
