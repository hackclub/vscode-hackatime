import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

// a tiny GET client for the few plain requests the extension makes (github releases, cli
// downloads), replacing the deprecated `request` package. it covers the three things that
// package did for us: following redirects (github downloads 302 to another host), the
// wakatime `proxy` setting, and `no_ssl_verify`.

export interface GetOptions {
  proxy?: string;
  // false skips TLS certificate checks, for the wakatime `no_ssl_verify` setting
  strictSSL?: boolean;
  headers?: Record<string, string>;
  maxRedirects?: number;
  // gives up when the connection goes quiet for this long
  idleTimeoutMs?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function get(url: string, opts: GetOptions, redirectsLeft: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const lib = target.protocol === 'http:' ? http : https;
    const strict = opts.strictSSL !== false;
    const request = lib.get(
      target,
      {
        headers: opts.headers,
        rejectUnauthorized: strict,
        // without a wakatime proxy setting, leave the agent alone so VS Code's own proxy
        // support (it patches node's http/https in the extension host) still applies
        agent: opts.proxy
          ? new HttpsProxyAgent(opts.proxy, { rejectUnauthorized: strict })
          : undefined,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECTS.has(status) && location) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects fetching ${url}`));
          return resolve(get(new URL(location, target).toString(), opts, redirectsLeft - 1));
        }
        resolve(response);
      },
    );
    request.setTimeout(opts.idleTimeoutMs ?? 60_000, () =>
      request.destroy(new Error(`Timed out fetching ${url}`)),
    );
    request.on('error', reject);
  });
}

export async function getJson(
  url: string,
  opts: GetOptions = {},
): Promise<{ status: number; body: any }> {
  const response = await get(url, opts, opts.maxRedirects ?? 5);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.statusCode ?? 0, body };
}

// saves the response body to `file`, rejecting (and removing anything half written) on a
// non-2xx response or a dropped connection
export async function downloadToFile(
  url: string,
  file: string,
  opts: GetOptions = {},
): Promise<void> {
  const response = await get(url, opts, opts.maxRedirects ?? 5);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    response.resume();
    throw new Error(`Download of ${url} failed with status ${status}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const fail = (e: Error) => {
      out.destroy();
      fs.rm(file, { force: true }, () => reject(e));
    };
    response.on('error', fail);
    response.on('aborted', () => fail(new Error(`Download of ${url} was interrupted`)));
    out.on('error', fail);
    out.on('finish', resolve);
    response.pipe(out);
  });
}
