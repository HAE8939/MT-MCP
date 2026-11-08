import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { canonicalRequest } from '../src/packs/imagebed/signature.js';

describe('COS signature canonical request', () => {
  it('matches the published PUT example digest', () => {
    const signed = canonicalRequest({
      method: 'PUT',
      pathname: '/exampleobject(腾讯云)',
      headers: {
        'content-length': '13',
        'content-md5': 'mQ/fVh815F3k6TAUm8m0eg==',
        'content-type': 'text/plain',
        date: 'Thu, 16 May 2019 06:45:51 GMT',
        host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
        'x-cos-acl': 'private',
        'x-cos-grant-read': 'uin="100000000011"',
      },
    });
    assert.equal(signed.headerList, 'content-length;content-md5;content-type;date;host;x-cos-acl;x-cos-grant-read');
    assert.equal(signed.urlParamList, '');
    assert.equal(createHash('sha1').update(signed.httpString).digest('hex'), '8b2751e77f43a0995d6e9eb9477f4b685cca4172');
  });

  it('matches the published GET example digest', () => {
    const signed = canonicalRequest({
      method: 'GET',
      pathname: '/exampleobject(腾讯云)',
      query: {
        'response-content-type': 'application/octet-stream',
        'response-cache-control': 'max-age=600',
      },
      headers: {
        date: 'Thu, 16 May 2019 06:55:53 GMT',
        host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
      },
    });
    assert.equal(signed.urlParamList, 'response-cache-control;response-content-type');
    assert.equal(
      signed.queryString,
      'response-cache-control=max-age%3D600&response-content-type=application%2Foctet-stream',
    );
    assert.equal(createHash('sha1').update(signed.httpString).digest('hex'), '54ecfe22f59d3514fdc764b87a32d8133ea611e6');
  });
});
