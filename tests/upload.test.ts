import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseBucketListing } from '../src/packs/imagebed/cos.js';
import { PublicError, scrubClientMessage } from '../src/packs/imagebed/errors.js';
import { fetchPublicImage, isPublicIp } from '../src/packs/imagebed/remote.js';
import { deleteImage, listImages, uploadImage } from '../src/packs/imagebed/service.js';
import {
  IMAGEBED_DELETE,
  IMAGEBED_LIST,
  IMAGEBED_UPLOAD,
} from '../src/packs/imagebed/index.js';
import { appConfig, assertNoSecrets, authHeader, memoryStore, PNG, postMcp, startServer, TOKEN } from './helpers.js';

const fixedNow = () => new Date('2026-11-08T02:03:04.000Z');

describe('image bed upload path', () => {
  it('stores a png under the prefix and returns the public COS url', async () => {
    const store = memoryStore();
    const config = appConfig();
    assert.ok(config.cos);
    const result = await uploadImage(
      { filename: '../secret/../../pixel.png', contentBase64: PNG.toString('base64'), contentType: 'image/png' },
      { cos: config.cos, store, maxUploadBytes: config.maxUploadBytes, now: fixedNow, nonce: () => 'abcd1234' },
    );
    assert.equal(result.key, 'dmds/20261108T020304Z-abcd1234-pixel.png');
    assert.equal(result.url, `https://dmds-images-1259154611.cos.ap-guangzhou.myqcloud.com/${result.key}`);
    assert.equal(result.content_type, 'image/png');
    assert.equal(result.size, PNG.length);
    const stored = store.objects.get(result.key);
    assert.equal(stored?.acl, 'public-read');
    assert.equal(stored?.contentType, 'image/png');
    assert.deepEqual(stored?.body, PNG);
  });

  it('uses the CDN origin when configured and accepts a data URL', async () => {
    const store = memoryStore();
    const config = appConfig({ COS_CDN_DOMAIN: 'https://img.example.com' });
    assert.ok(config.cos);
    const result = await uploadImage(
      { filename: 'dot.png', contentBase64: `data:image/png;base64,${PNG.toString('base64')}` },
      { cos: config.cos, store, maxUploadBytes: config.maxUploadBytes, now: fixedNow, nonce: () => 'abcd1234' },
    );
    assert.equal(result.url, `https://img.example.com/${result.key}`);
  });

  it('rejects non-images, mismatched types, oversize bodies, and bad keys', async () => {
    const store = memoryStore();
    const config = appConfig({ MAX_UPLOAD_BYTES: '1024' });
    assert.ok(config.cos);
    const deps = { cos: config.cos, store, maxUploadBytes: config.maxUploadBytes, now: fixedNow, nonce: () => 'abcd1234' };

    await assert.rejects(
      () => uploadImage({ filename: 'note.txt', contentBase64: Buffer.from('hello').toString('base64') }, deps),
      /jpeg, png, gif, and webp/,
    );
    await assert.rejects(
      () =>
        uploadImage(
          { filename: 'dot.png', contentBase64: PNG.toString('base64'), contentType: 'image/jpeg' },
          deps,
        ),
      /does not match/,
    );
    const tooBig = Buffer.concat([PNG, Buffer.alloc(2_000)]);
    await assert.rejects(
      () => uploadImage({ filename: 'dot.png', contentBase64: tooBig.toString('base64') }, deps),
      /size limit/,
    );
    await assert.rejects(() => uploadImage({ filename: 'dot.png' }, deps), /exactly one/);
    await assert.rejects(() => deleteImage('../dmds/pixel.png', deps), /image bed prefix/);
    await assert.rejects(() => deleteImage('other/pixel.png', deps), /image bed prefix/);
    await assert.rejects(() => listImages({ prefix: '../' }, deps), /image bed root/);

    const uploaded = await uploadImage(
      { filename: 'dot.png', contentBase64: PNG.toString('base64') },
      deps,
    );
    const listed = await listImages({}, deps);
    assert.equal(listed.objects.length, 1);
    assert.equal(listed.objects[0]?.key, uploaded.key);
    const removed = await deleteImage(uploaded.key, deps);
    assert.equal(removed.deleted, true);
    assert.equal((await listImages({}, deps)).objects.length, 0);
  });

  it('parses a bucket listing and scrubs signed headers from errors', () => {
    const listing = parseBucketListing(`<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents>
          <Key>dmds/a&amp;b.png</Key>
          <Size>12</Size>
          <LastModified>2026-11-08T00:00:00.000Z</LastModified>
        </Contents>
      </ListBucketResult>`);
    assert.equal(listing.objects[0]?.key, 'dmds/a&b.png');
    assert.equal(listing.truncated, false);
    assert.throws(() => parseBucketListing('<!DOCTYPE foo [<!ENTITY x "y">]>'), /unexpected/);
    const scrubbed = scrubClientMessage('denied q-ak=AKIDEXAMPLE&q-signature=abcdef Authorization: Bearer secret');
    assert.equal(scrubbed.includes('AKIDEXAMPLE'), false);
    assert.equal(scrubbed.includes('abcdef'), false);
    assert.equal(scrubbed.includes('Bearer secret'), false);
  });
});

describe('source_url guard', () => {
  it('refuses private and non-https targets before any upload', async () => {
    const store = memoryStore();
    const config = appConfig();
    assert.ok(config.cos);
    const deps = {
      cos: config.cos,
      store,
      maxUploadBytes: config.maxUploadBytes,
      remote: {
        lookup: async () => {
          throw new Error('lookup should not run');
        },
        request: async () => {
          throw new Error('request should not run');
        },
      },
    };
    for (const sourceUrl of [
      'http://example.com/a.png',
      'https://user:pass@example.com/a.png',
      'https://127.0.0.1/a.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/a.png',
      'https://metadata.google.internal/a.png',
    ]) {
      await assert.rejects(() => uploadImage({ filename: 'a.png', sourceUrl }, deps), PublicError);
    }
    assert.equal(store.objects.size, 0);
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('192.168.1.10'), false);
    assert.equal(isPublicIp('::1'), false);
  });

  it('pins the fetch to the resolved public address and follows only public redirects', async () => {
    const seen: string[] = [];
    const body = await fetchPublicImage('https://cdn.example/a.png', 1024, {
      lookup: async (hostname) => {
        if (hostname === 'cdn.example') return ['1.1.1.1'];
        if (hostname === 'img.example') return ['8.8.8.8'];
        return ['10.0.0.5'];
      },
      request: async (target) => {
        seen.push(`${target.ip} ${target.hostname} ${target.path}`);
        if (target.hostname === 'cdn.example') {
          return { status: 302, headers: { location: 'https://img.example/b.png' }, body: Buffer.alloc(0) };
        }
        return { status: 200, headers: {}, body: PNG };
      },
    });
    assert.deepEqual(body, PNG);
    assert.deepEqual(seen, ['1.1.1.1 cdn.example /a.png', '8.8.8.8 img.example /b.png']);

    await assert.rejects(
      () =>
        fetchPublicImage('https://cdn.example/a.png', 1024, {
          lookup: async () => ['1.1.1.1', '10.0.0.5'],
          request: async () => {
            throw new Error('must not fetch a mixed record');
          },
        }),
      /not allowed/,
    );
  });
});

describe('image bed over MCP', () => {
  it('lists only the image bed tools and uploads through tools/call', async () => {
    const store = memoryStore();
    const running = await startServer(store);
    try {
      const listed = await postMcp(
        running.base,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        authHeader(),
      );
      assert.equal(listed.status, 200, listed.text);
      const names = JSON.stringify(listed.message);
      assert.match(names, new RegExp(IMAGEBED_UPLOAD));
      assert.match(names, new RegExp(IMAGEBED_LIST));
      assert.match(names, new RegExp(IMAGEBED_DELETE));
      assert.equal(names.includes('generation_'), false);
      assert.equal(names.includes('docs_'), false);

      const uploaded = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: IMAGEBED_UPLOAD,
            arguments: { filename: 'dot.png', content_base64: PNG.toString('base64') },
          },
        },
        authHeader(),
      );
      assert.equal(uploaded.status, 200, uploaded.text);
      const payload = JSON.stringify(uploaded.message);
      assert.match(payload, /https:\/\/dmds-images-1259154611\.cos\.ap-guangzhou\.myqcloud\.com\/dmds\//);
      assert.equal(payload.includes(TOKEN), false);
      assert.equal(store.objects.size, 1);
      const key = [...store.objects.keys()][0];
      assert.ok(key?.startsWith('dmds/'));

      const removed = await postMcp(
        running.base,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: IMAGEBED_DELETE, arguments: { key } },
        },
        authHeader(),
      );
      assert.equal(removed.status, 200, removed.text);
      assert.match(JSON.stringify(removed.message), /已删除/);
      assert.equal(store.objects.size, 0);
    } finally {
      await running.close();
    }
  });

  it('hides image bed tools when COS is not configured', async () => {
    const running = await startServer(null, {
      COS_SECRET_ID: undefined,
      COS_SECRET_KEY: undefined,
      COS_REGION: undefined,
      COS_BUCKET: undefined,
      COS_PREFIX: undefined,
    });
    try {
      const health = await fetch(`${running.base}/health`);
      assert.match(await health.text(), /"id":"imagebed","enabled":false/);
      const listed = await postMcp(running.base, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authHeader());
      assert.equal(listed.status, 200, listed.text);
      assert.equal(JSON.stringify(listed.message).includes(IMAGEBED_UPLOAD), false);
    } finally {
      await running.close();
    }
  });
});
