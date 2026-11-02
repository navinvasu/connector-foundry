import { describe, expect, it } from 'vitest';
import { matchesSearch, parseSearchTerms } from './toolSearch';

const tools = [
  { name: 'getGet', upstream: 'GET /get' },
  { name: 'getIp', upstream: 'GET /ip' },
  { name: 'getUuid', upstream: 'GET /uuid' },
  { name: 'postAnything', upstream: 'POST /anything' },
];

describe('parseSearchTerms', () => {
  it('treats a single line as one term', () => {
    expect(parseSearchTerms('GET /get')).toEqual(['get /get']);
  });

  it('splits a pasted list into one term per line', () => {
    expect(parseSearchTerms('GET /get\nGET /ip\nGET /uuid\n')).toEqual(['get /get', 'get /ip', 'get /uuid']);
  });

  it('handles CRLF pastes and blank lines', () => {
    expect(parseSearchTerms('GET /get\r\n\r\n  GET /ip  \r\n')).toEqual(['get /get', 'get /ip']);
  });

  it('ignores empty queries', () => {
    expect(parseSearchTerms('')).toEqual([]);
    expect(parseSearchTerms('   \n  ')).toEqual([]);
  });
});

describe('matchesSearch', () => {
  it('matches a single term against name or upstream, case-insensitively', () => {
    expect(matchesSearch(tools[0]!, ['get /get'])).toBe(true);
    expect(matchesSearch(tools[0]!, ['GETGET'])).toBe(true);
    expect(matchesSearch(tools[0]!, ['post'])).toBe(false);
  });

  it('matches ANY term, so a pasted list finds every tool', () => {
    const terms = parseSearchTerms('GET /get\nGET /ip\nGET /uuid');
    expect(tools.filter((t) => matchesSearch(t, terms)).map((t) => t.name))
      .toEqual(['getGet', 'getIp', 'getUuid']);
  });

  it('matches nothing with an empty term list only when asked', () => {
    expect(matchesSearch(tools[0]!, [])).toBe(false);
  });
});
