// DP-05: PII + secret redaction before logging/telemetry/storage.
// The AC fixture list lives here: every sensitive shape must be redacted,
// every look-alike must survive. Surfaces covered: redactString/redactValue
// units, the structured logger, audit() metadata, and invoke() results +
// telemetry prompt_ref (DB + fetch stubbed, circuit-breaker.test pattern).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one, exec } from './db.js';
import { redactString, redactValue, isSensitiveKey, REDACTED } from './redact.js';
import { logger } from './logger.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);

// ─── redactString: the PII fixture list ────────────────────────────────────

/** [label, input, forbidden substrings that must NOT survive] */
const PII_FIXTURES: Array<[string, string, string[]]> = [
  ['email in prose', 'Contact ada@example.com for help', ['ada@example.com']],
  ['email in a URL path', 'https://x.test/users/ada@example.com/profile', ['ada@example.com']],
  ['bearer token', 'Authorization: Bearer abc123.def-456_ghi', ['abc123.def-456_ghi']],
  ['basic credentials', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA==']],
  ['JWT', 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3AAA end',
    ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3AAA']],
  ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE leaked', ['AKIAIOSFODNN7EXAMPLE']],
  ['GitHub token', 'tok ghp_1234567890abcdefghij1234567890abcd done', ['ghp_1234567890abcdefghij1234567890abcd']],
  ['Stripe live key', 'charged with sk_live_TESTKEY1 ok', ['sk_live_TESTKEY1']],
  ['Stripe webhook secret', 'whsec_abcdef1234567890ABCDEF12', ['whsec_abcdef1234567890ABCDEF12']],
  ['OpenAI-style key', 'sk-proj-abcdef1234567890ABCDEF1234567890', ['sk-proj-abcdef1234567890ABCDEF1234567890']],
  ['Slack token', 'xoxb-123456789012-abcdefghijkl', ['xoxb-123456789012-abcdefghijkl']],
  ['Google API key', 'AIzaSyD4iE2vH7examplekey1234567890abc', ['AIzaSyD4iE2vH7examplekey1234567890abc']],
  ['SSN', 'SSN on file: 078-05-1120', ['078-05-1120']],
  ['card, spaced', 'card 4242 4242 4242 4242 charged', ['4242 4242 4242 4242']],
  ['card, bare', 'card 4242424242424242 charged', ['4242424242424242']],
  ['card, dashed Amex', 'amex 3782-822463-10005 charged', ['3782-822463-10005']],
  ['phone, parens', 'call (415) 555-0132 today', ['(415) 555-0132', '555-0132']],
  ['phone, +1', 'call +1 415-555-0132 today', ['415-555-0132']],
  ['phone, dots', 'call 415.555.0132 today', ['415.555.0132']],
  ['URL api_key param', 'https://api.test/v1?api_key=abc123xyz&page=2', ['abc123xyz']],
  ['URL token param', 'https://api.test/v1?token=tok_98765&city=Berlin', ['tok_98765']],
  ['URL google-style key param', 'https://maps.test/api?key=supersecretvalue1&v=3', ['supersecretvalue1']],
  ['URL signature param', 'https://s3.test/obj?signature=deadbeefcafe&x=1', ['deadbeefcafe']],
];

describe('redactString — PII fixture list', () => {
  for (const [label, input, forbidden] of PII_FIXTURES) {
    it(`redacts ${label}`, () => {
      const out = redactString(input);
      for (const f of forbidden) expect(out).not.toContain(f);
      expect(out).toContain(REDACTED);
    });
  }

  it('keeps benign URL params while redacting sensitive ones', () => {
    const out = redactString('https://api.test/v1?api_key=abc123xyz&page=2&city=Berlin');
    expect(out).toContain('page=2');
    expect(out).toContain('city=Berlin');
  });
});

describe('redactString — look-alikes survive', () => {
  const SAFE: string[] = [
    'Order 1234567812345678 shipped',        // 16 digits, fails Luhn → an ID, not a card
    'Order total 4242.42 due',               // amount, not a card number
    'Ship by 2026-09-30 please',             // a date, not a phone/SSN
    'Ada Lovelace lives in Berlin',          // names/places have no PII shape
    'version v1.2.3 released',               // dotted version, not a phone
    'https://api.test/v1?city=Berlin&limit=50&page=2', // benign params
    'Call 555-0132 for the front desk',      // 7-digit local number: no area code, kept
    'Invoice INV-2026-0042 total 99.50',     // invoice id + amount
  ];
  for (const s of SAFE) {
    it(`keeps: ${s}`, () => {
      expect(redactString(s)).toBe(s);
    });
  }
});

// ─── redactValue: key-based + deep ─────────────────────────────────────────

describe('redactValue — key-based redaction', () => {
  it('redacts values under secret/PII keys whatever their format', () => {
    const out = redactValue({
      password: 'hunter2',
      api_key: 'not-a-known-shape',
      authorization: 'anything',
      email: 'not-even-an-email',
      contact_phone: 'call-me-maybe',
      ssn: 'redact-me',
      card_number: '1234',
      nested: { client_secret: 'shh', note: 'fine' },
    }) as any;
    expect(out.password).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.email).toBe(REDACTED);
    expect(out.contact_phone).toBe(REDACTED);
    expect(out.ssn).toBe(REDACTED);
    expect(out.card_number).toBe(REDACTED);
    expect(out.nested.client_secret).toBe(REDACTED);
    expect(out.nested.note).toBe('fine');
  });

  it('pattern-redacts string values under innocent keys, deep in arrays', () => {
    const out = redactValue({ events: [{ note: 'mail ada@example.com' }, { note: 'all good' }] }) as any;
    expect(out.events[0].note).toBe('mail REDACTED');
    expect(out.events[1].note).toBe('all good');
  });

  it('preserves benign scalars and structures', () => {
    const input = { name: 'Ada Lovelace', city: 'Berlin', total: 4242.42, count: 3, ok: true, ref: null };
    expect(redactValue(input)).toEqual(input);
  });

  it('keeps the prototype caps: depth, array size, string length', () => {
    const long = redactValue('x'.repeat(2500)) as string;
    expect(long.length).toBe(2000 + '…[truncated]'.length);
    expect(long.endsWith('…[truncated]')).toBe(true);
    const deep = redactValue({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }) as any;
    expect(deep.a.b.c.d.e.f.g).toBe('[truncated]');
  });

  it('isSensitiveKey covers the fixture key names', () => {
    for (const k of ['password', 'apiKey', 'access_token', 'email', 'phone', 'ssn', 'card_number', 'session_id']) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    for (const k of ['name', 'city', 'total', 'status', 'tool_name']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });
});

// ─── surface: structured logger ────────────────────────────────────────────

describe('logger — fields are redacted on emit (DP-05)', () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    lines = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      lines.push(String(chunk));
      return true;
    }) as any);
  });
  afterEach(() => spy.mockRestore());

  it('never writes an email, bearer token, or key-shaped field to stdout', () => {
    logger.info({
      msg: 'upstream failed',
      error: 'GET https://up.test/x?api_key=abc123xyz failed for ada@example.com (Bearer abc123.def-456)',
      api_key: 'sk_live_TESTKEY1',
    });
    const line = lines.join('');
    expect(line).not.toContain('ada@example.com');
    expect(line).not.toContain('abc123.def-456');
    expect(line).not.toContain('abc123xyz');
    expect(line).not.toContain('sk_live_TESTKEY1');
    expect(line).toContain(REDACTED);
    expect(JSON.parse(line)).toMatchObject({ msg: 'upstream failed', level: 'info' });
  });
});

// ─── surface: invoke() result + telemetry ──────────────────────────────────

const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');

describe('invoke — upstream PII never reaches the result or telemetry (DP-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpstreamBreakers();
    oneMock
      .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
      .mockResolvedValueOnce({
        tool_snapshot: {
          name: 'getCustomer',
          upstream: { base_url: 'https://api.example.com', path_template: '/customer', param_bindings: [] },
          recovery_rules: [],
        },
      });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        customer_email: 'ada@example.com',
        customer: { name: 'Ada', phone: '(415) 555-0132' },
        card_number: '4242 4242 4242 4242',
        note: 'reach ada@example.com or 415.555.0132',
        order_id: 'ord_123',
        total: 99.5,
      }),
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('redacts the invoke result and the stored prompt_ref', async () => {
    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'getCustomer', args: {},
      prompt_ref: 'ticket for ada@example.com',
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.customer_email).toBe(REDACTED);
    expect(result.customer.phone).toBe(REDACTED);
    expect(result.card_number).toBe(REDACTED);
    expect(result.note).toBe('reach REDACTED or REDACTED');
    // Benign fields survive untouched.
    expect(result.customer.name).toBe('Ada');
    expect(result.order_id).toBe('ord_123');
    expect(result.total).toBe(99.5);
    // Telemetry row: prompt_ref is stored redacted.
    const telemetry = execMock.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO telemetry_events'));
    expect(telemetry).toBeTruthy();
    const telemetryParams = telemetry![1] as any[];
    expect(telemetryParams[7]).toBe('ticket for REDACTED');
  });
});
