/**
 * The return trip around the login gate: the `next` a gate writes into the URL,
 * and what the auth form is willing to follow when it reads it back. The second
 * half is the one that matters — `next` is attacker-supplied by definition, so
 * anything that could leave this origin has to read as the front door instead.
 */
import { describe, expect, it } from 'vitest';
import { returnTo, signInHref, signUpHref } from '../src/lib/nav';

describe('the way in, and back', () => {
  it('carries the destination through both doors', () => {
    expect(signInHref('/chats')).toBe('/login?next=%2Fchats');
    expect(signUpHref('/p/abc')).toBe('/signup?next=%2Fp%2Fabc');
  });

  it('leaves the front page out — it is where both doors already land', () => {
    expect(signInHref('/')).toBe('/login');
    expect(signUpHref('/')).toBe('/signup');
  });

  it('round-trips a path with a query, which is what a deep link is', () => {
    const back = '/chats/6f1?panel=notes';
    expect(returnTo(new URLSearchParams(signInHref(back).split('?')[1]).get('next'))).toBe(back);
  });
});

describe('returnTo', () => {
  it('follows an internal path', () => {
    expect(returnTo('/chats')).toBe('/chats');
    expect(returnTo('/p/abc?tab=comments#top')).toBe('/p/abc?tab=comments#top');
  });

  it('sends a reader with nothing to go back to the front page', () => {
    expect(returnTo(null)).toBe('/');
    expect(returnTo(undefined)).toBe('/');
    expect(returnTo('')).toBe('/');
    expect(returnTo('/')).toBe('/');
  });

  it('refuses anything that could leave this origin', () => {
    // Protocol-relative: `//host` is a URL, and a browser reads `\` as `/`.
    expect(returnTo('//evil.example/pwn')).toBe('/');
    expect(returnTo('/\\evil.example/pwn')).toBe('/');
    expect(returnTo('https://evil.example')).toBe('/');
    expect(returnTo('javascript:alert(1)')).toBe('/');
    // Not a path at all: no leading slash, so nothing says it is ours.
    expect(returnTo('chats')).toBe('/');
  });

  /** `?next=a&next=b` is a string[] by the time a page hands it over. */
  it('refuses a `next` somebody sent twice', () => {
    expect(returnTo(['/chats', '/notes'])).toBe('/');
  });
});
