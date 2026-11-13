export const MAX_METADATA_BYTES = 16 * 1024 * 1024;

export async function readMetadata(response, limit = MAX_METADATA_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('metadata response exceeds size limit');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('metadata response exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
