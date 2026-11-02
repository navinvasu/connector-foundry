import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
}));
vi.mock('../data/api', () => ({ api: apiMock }));

type ApiCall = [string, RequestInit];
const calls = () => apiMock.mock.calls as unknown as ApiCall[];

import { useFoundryStore } from './store';
import type { Finding } from '../data/types';

const finding = (over: Partial<Finding> & { id: string }): Finding => ({
  severity: 'warning',
  code: 'EFFECT',
  title: 't',
  detail: 'd',
  status: 'open',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useFoundryStore.setState({
    findings: [
      finding({ id: 'a' }),
      finding({ id: 'b', severity: 'info' }),
      finding({ id: 'c', status: 'resolved' }),
    ],
  });
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('bulk review actions', () => {
  it('acknowledgeFindings flips many to acknowledged and PATCHes each', async () => {
    useFoundryStore.getState().acknowledgeFindings(['a', 'b']);
    const fs = useFoundryStore.getState().findings;
    expect(fs.find((f) => f.id === 'a')!.status).toBe('acknowledged');
    expect(fs.find((f) => f.id === 'b')!.status).toBe('acknowledged');
    expect(fs.find((f) => f.id === 'c')!.status).toBe('resolved');
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(calls()[0][0]).toMatch(/\/v1\/projects\/review\/a$/);
    expect(calls()[1][0]).toMatch(/\/v1\/projects\/review\/b$/);
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ status: 'acknowledged' });
  });

  it('resolveFindings flips many to resolved and PATCHes each', async () => {
    useFoundryStore.getState().resolveFindings(['a', 'b']);
    const fs = useFoundryStore.getState().findings;
    expect(fs.find((f) => f.id === 'a')!.status).toBe('resolved');
    expect(fs.find((f) => f.id === 'b')!.status).toBe('resolved');
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(calls()[0][1].body as string)).toEqual({ status: 'resolved' });
  });

  it('bulk actions with an empty selection do nothing', async () => {
    useFoundryStore.getState().resolveFindings([]);
    useFoundryStore.getState().acknowledgeFindings([]);
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
    expect(useFoundryStore.getState().findings.filter((f) => f.status === 'open')).toHaveLength(2);
  });
});
