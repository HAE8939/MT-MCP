import type { CosSettings } from '../../config.js';
import { PublicError } from './errors.js';
import type { ObjectStore } from './cos.js';
import { fetchPublicImage, type RemoteFetchDeps } from './remote.js';
import {
  assertAllowedImage,
  assertKeyInPrefix,
  decodeBase64Image,
  objectKey,
  publicObjectUrl,
  randomNonce,
  resolveListPrefix,
} from './validate.js';

export interface ImageBedDeps {
  cos: CosSettings;
  store: ObjectStore;
  maxUploadBytes: number;
  now?: () => Date;
  nonce?: () => string;
  remote?: RemoteFetchDeps;
}

export interface UploadInput {
  filename: string;
  contentBase64?: string;
  sourceUrl?: string;
  contentType?: string;
}

export interface UploadResult {
  url: string;
  key: string;
  content_type: string;
  size: number;
  etag?: string;
}

export async function uploadImage(input: UploadInput, deps: ImageBedDeps): Promise<UploadResult> {
  const filename = input.filename.trim();
  if (!filename || filename.length > 200) throw new PublicError('filename is required and must be at most 200 characters.');
  const hasBytes = Boolean(input.contentBase64 && input.contentBase64.trim());
  const hasUrl = Boolean(input.sourceUrl && input.sourceUrl.trim());
  if (hasBytes === hasUrl) {
    throw new PublicError('Provide exactly one of content_base64 or source_url.');
  }
  const body = hasBytes
    ? decodeBase64Image(input.contentBase64 ?? '', deps.maxUploadBytes)
    : await fetchPublicImage(input.sourceUrl ?? '', deps.maxUploadBytes, deps.remote);
  const image = assertAllowedImage(body, input.contentType, deps.maxUploadBytes);
  const key = objectKey(
    deps.cos.prefix,
    filename,
    image.ext,
    deps.now?.() ?? new Date(),
    deps.nonce?.() ?? randomNonce(),
  );
  const stored = await deps.store.putObject({
    key,
    body,
    contentType: image.mime,
    acl: deps.cos.objectAcl,
  });
  return {
    url: publicObjectUrl(deps.cos, key),
    key,
    content_type: image.mime,
    size: body.length,
    etag: stored.etag,
  };
}

export async function listImages(
  input: { prefix?: string; maxKeys?: number },
  deps: ImageBedDeps,
): Promise<{
  prefix: string;
  truncated: boolean;
  objects: Array<{ key: string; url: string; size: number; last_modified?: string }>;
}> {
  const maxKeys = input.maxKeys ?? 50;
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 100) {
    throw new PublicError('max_keys must be an integer from 1 to 100.');
  }
  const prefix = resolveListPrefix(deps.cos.prefix, input.prefix);
  const listed = await deps.store.listObjects({ prefix, maxKeys });
  return {
    prefix,
    truncated: listed.truncated,
    objects: listed.objects
      .filter((object) => object.key.startsWith(deps.cos.prefix))
      .map((object) => ({
        key: object.key,
        url: publicObjectUrl(deps.cos, object.key),
        size: object.size,
        ...(object.lastModified ? { last_modified: object.lastModified } : {}),
      })),
  };
}

export async function deleteImage(key: string, deps: ImageBedDeps): Promise<{ key: string; deleted: true }> {
  const safe = assertKeyInPrefix(key.trim(), deps.cos.prefix);
  await deps.store.deleteObject({ key: safe });
  return { key: safe, deleted: true };
}
