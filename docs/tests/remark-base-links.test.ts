import { describe, it, expect } from 'vitest';
import { remark } from 'remark';
import remarkBaseLinks, { prefixUrl } from '../src/plugins/remark-base-links';

describe('prefixUrl', () => {
  const cases: Array<{ name: string; url: string; base: string; want: string }> = [
    { name: 'base "/" leaves links unchanged', url: '/intro/', base: '/', want: '/intro/' },
    { name: 'sub-path base prefixes internal links', url: '/intro/', base: '/lgtm-pack/', want: '/lgtm-pack/intro/' },
    { name: 'prefixes image paths', url: '/img/a.png', base: '/lgtm-pack/', want: '/lgtm-pack/img/a.png' },
    { name: 'never rewrites external links', url: 'https://example.com', base: '/lgtm-pack/', want: 'https://example.com' },
    { name: 'never rewrites protocol-relative links', url: '//example.com/x', base: '/lgtm-pack/', want: '//example.com/x' },
    { name: 'never rewrites anchor-only links', url: '#section', base: '/lgtm-pack/', want: '#section' },
    { name: 'preserves anchors on internal links', url: '/intro/#step-1', base: '/lgtm-pack/', want: '/lgtm-pack/intro/#step-1' },
    { name: 'idempotent on already-prefixed links', url: '/lgtm-pack/intro/', base: '/lgtm-pack/', want: '/lgtm-pack/intro/' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(prefixUrl(c.url, c.base)).toBe(c.want);
    });
  }
});

describe('remarkBaseLinks plugin', () => {
  it('rewrites link and image urls in a markdown document', async () => {
    const md = 'See [Intro](/intro/) and ![img](/img/a.png) and [ext](https://x.io)';
    const out = String(
      await remark().use(remarkBaseLinks, { base: '/lgtm-pack/' }).process(md),
    );
    expect(out).toContain('(/lgtm-pack/intro/)');
    expect(out).toContain('(/lgtm-pack/img/a.png)');
    expect(out).toContain('(https://x.io)');
  });

  it('is a no-op when base is "/"', async () => {
    const md = '[I](/intro/)';
    const out = String(await remark().use(remarkBaseLinks, { base: '/' }).process(md));
    expect(out).toContain('(/intro/)');
  });
});
