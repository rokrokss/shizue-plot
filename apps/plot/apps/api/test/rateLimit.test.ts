/**
 * Whom the address-counted buckets count (`clientAddress`, `rateLimit.ts`). The
 * windows themselves are counted in Postgres and tested in api.test.ts, beside
 * the routes that carry them.
 */
import { describe, expect, it } from 'vitest';
import { clientAddress } from '../src/rateLimit.js';

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe('the client address', () => {
  it('reads the header CLIENT_IP_HEADER names first, when the request carries it', () => {
    const env = { CLIENT_IP_HEADER: 'CF-Connecting-IP' };
    const both = headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '192.0.2.1' });
    expect(clientAddress(both, env, '127.0.0.1')).toBe('203.0.113.7');
    // Absent from the request, the forwarded chain answers.
    expect(clientAddress(headers({ 'x-forwarded-for': '192.0.2.1' }), env, '127.0.0.1')).toBe('192.0.2.1');
  });

  it('takes the rightmost forwarded entry, the one the nearest proxy appended, over anything the client wrote before it', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': '10.0.0.1, 198.51.100.4,203.0.113.7' }), {}, '127.0.0.1')).toBe('203.0.113.7');
    expect(clientAddress(headers({ 'x-forwarded-for': ' 203.0.113.7 , , ' }), {}, '127.0.0.1')).toBe('203.0.113.7');
    // Without CLIENT_IP_HEADER another proxy's header is only a header.
    expect(clientAddress(headers({ 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' }), {}, undefined)).toBe('203.0.113.7');
  });

  it('falls back to the socket, and to one shared key when there is none', () => {
    expect(clientAddress(headers({}), {}, '198.51.100.4')).toBe('198.51.100.4');
    expect(clientAddress(headers({ 'x-forwarded-for': ' , ' }), {}, '198.51.100.4')).toBe('198.51.100.4');
    expect(clientAddress(headers({}), {}, undefined)).toBe('unknown');
  });

  it('counts an IPv6 client by its /64 and an IPv4-mapped one as its IPv4', () => {
    const key = (address: string) => clientAddress(headers({ 'x-forwarded-for': address }), {}, undefined);
    expect(key('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(key('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(key('2001:db8:1:3::9')).toBe('2001:db8:1:3::/64');
    expect(key('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress(headers({}), {}, '::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('keeps what is not an address as written, cut short', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': 'x'.repeat(200) }), {}, undefined)).toBe('x'.repeat(64));
  });
});
