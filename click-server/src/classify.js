// Request classification. Uses only data the browser sends anyway (no cookies, no JS).
import { sha256Hex } from './b64.js';

const PREVIEW_UA = /(Slackbot-LinkExpanding|Slackbot|WhatsApp\/|facebookexternalhit|Facebot|Twitterbot|TelegramBot|Discordbot|LinkedInBot|SkypeUriPreview|redditbot|Embedly|iframely)/i;
const CRAWLER_UA = /(Googlebot|bingbot|OAI-SearchBot|ChatGPT-User|GPTBot|PerplexityBot|ClaudeBot|Claude-User|anthropic-ai|Applebot|YandexBot|DuckDuckBot|Baiduspider|AhrefsBot|SemrushBot|bot\b|crawler|spider|curl\/|wget\/|python-requests|node-fetch|axios|Go-http-client)/i;
const HEADLESS_UA = /(HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium)/i;
const BROWSER_UA = /(Mozilla\/5\.0)/;

export function truncateIp(ip) {
  if (!ip) return '';
  if (ip.includes(':')) {               // IPv6 → /48
    const full = expandV6(ip); return full.slice(0, 3).join(':') + '::/48';
  }
  const p = ip.split('.'); return `${p[0]}.${p[1]}.${p[2]}.0/24`;
}
function expandV6(ip) {
  const [h, t = ''] = ip.split('::');
  const hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
  const mid = Array(8 - hs.length - ts.length).fill('0');
  return [...hs, ...(ip.includes('::') ? mid : []), ...ts].map(x => x.padStart(4, '0'));
}
function v4ToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
export function inCidrs(ip, cidrs) {
  if (!ip || ip.includes(':')) return cidrs.some(c => c.includes(':') && ip && expandV6(ip).join(':').startsWith(expandV6(c.split('/')[0]).slice(0, Number(c.split('/')[1]) / 16).join(':')));
  const n = v4ToInt(ip);
  return cidrs.some(c => {
    if (c.includes(':')) return false;
    const [base, bits] = c.split('/'); const b = Number(bits);
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Daily-rotated salt. secret never leaves the server; key changes each period. */
export function saltPeriod(now, cfg) { return Math.floor(now / cfg.saltRotationMs); }
export async function endUserKey({ ip, ua, acceptLanguage }, secret, now, cfg) {
  return sha256Hex(`${secret}|${saltPeriod(now, cfg)}|${truncateIp(ip)}|${ua ?? ''}|${acceptLanguage ?? ''}`);
}

/** Header-level classification. Returns {cls: 'preview'|'bot'|'candidate', reasons[]} */
export function classifyRequest(req, cfg) {
  const ua = req.ua ?? ''; const h = req.headers ?? {}; const reasons = [];
  if (req.method === 'HEAD') reasons.push('head');
  if (h['range']) reasons.push('range');
  if (PREVIEW_UA.test(ua)) reasons.push('unfurler');
  if (h['purpose'] === 'preview' || h['sec-purpose']?.includes('prefetch') || h['x-purpose'] === 'preview') reasons.push('prefetch');
  if (reasons.length) return { cls: 'preview', reasons };
  if (!ua) reasons.push('no_ua');
  if (CRAWLER_UA.test(ua)) reasons.push('crawler_ua');
  if (HEADLESS_UA.test(ua)) reasons.push('headless');
  if (inCidrs(req.ip, cfg.datacenterCidrs)) reasons.push('datacenter_ip');
  if (BROWSER_UA.test(ua)) {
    if (!h['accept'] || !/text\/html/.test(h['accept'])) reasons.push('odd_accept');
    if (!h['sec-fetch-mode'] && /Chrome\/|Firefox\/|Edg\//.test(ua)) reasons.push('missing_sec_fetch');
  }
  if (typeof req.cfBotScore === 'number' && req.cfBotScore < 30) reasons.push('cf_bot_score');
  if (h['signature-agent']) reasons.push('signed_agent');   // Web Bot Auth: declared bot
  return reasons.length ? { cls: 'bot', reasons } : { cls: 'candidate', reasons };
}
