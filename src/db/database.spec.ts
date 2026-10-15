import { isDbUnavailable } from './database';

describe('isDbUnavailable', () => {
  const err = (props: object) => Object.assign(new Error('x'), props);

  it.each([
    ['connection refused', err({ code: 'ECONNREFUSED' })],
    ['DNS failure', err({ code: 'ENOTFOUND' })],
    ['connection exception class 08', err({ code: '08006' })],
    ['server shutting down', err({ code: '57P01' })],
    ['too many connections', err({ code: '53300' })],
    ['statement timeout', err({ code: '57014' })],
    [
      'pool connect timeout',
      new Error('timeout exceeded when trying to connect'),
    ],
    ['dropped connection', new Error('Connection terminated unexpectedly')],
    ['error from another realm', { code: 'ECONNREFUSED', message: 'x' }],
  ])('%s → unavailable', (_, e) => expect(isDbUnavailable(e)).toBe(true));

  it.each([
    ['unique violation (a bug, not an outage)', err({ code: '23505' })],
    ['numeric overflow', err({ code: '22003' })],
    ['plain error', new Error('boom')],
    ['not an error', 'ECONNREFUSED'],
    ['null', null],
  ])('%s → not unavailable', (_, e) => expect(isDbUnavailable(e)).toBe(false));
});
