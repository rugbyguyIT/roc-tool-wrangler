// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — Azure Blob Storage helper (asset photos)
// Env: AZURE_STORAGE_CONNECTION_STRING
//
// The container is created on first use if it doesn't exist, so there is
// no manual portal setup beyond creating the storage account itself.
//
// SECURITY NOTE: the container is created with { access: 'blob' } —
// public read on individual blobs (not container listing). URLs are
// unguessable, but they are NOT authenticated. That is fine for photos
// of forklifts and radios. It would be WRONG for anything sensitive:
// do not extend this helper to store documents, IDs, or photos of
// people without switching to SAS tokens or a private container with a
// server-side proxy.
// ─────────────────────────────────────────────────────────────
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = 'asset-photos';
const MAX_BYTES = 8 * 1024 * 1024;
let _container = null;

// Every photo endpoint checks this first and returns a clean 503 rather
// than a stack trace when the storage account hasn't been wired up yet.
function configured() {
  return !!process.env.AZURE_STORAGE_CONNECTION_STRING;
}

async function getContainer() {
  if (_container) return _container;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING not configured');
  const service = BlobServiceClient.fromConnectionString(conn);
  const container = service.getContainerClient(CONTAINER);
  await container.createIfNotExists({ access: 'blob' });
  _container = container;
  return container;
}

// Uploads a base64 data URL ("data:image/jpeg;base64,…") and returns the
// public blob URL. Photos are never sent as multipart form data — the
// client canvas-downscales to ~1600px and base64-encodes, which keeps
// the request inside Static Web Apps' body-size cap. Base64 inflates
// bytes by ~33%, which is why the ceiling here is deliberately modest.
// `prefix` namespaces the blob name so different entities can't collide.
async function uploadDataUrl(prefix, id, dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 image data URL');
  const [, mime, b64] = match;
  const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_BYTES) throw new Error('Image too large (8MB max)');

  const container = await getContainer();
  const blobName = `${prefix}/${id}-${Date.now()}.${ext}`;
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mime } });
  return blockBlob.url;
}

// Best-effort delete. A blob that fails to delete is orphaned storage,
// not a broken app, so callers should not fail the request over it.
async function remove(url) {
  try {
    const container = await getContainer();
    const name = decodeURIComponent(new URL(url).pathname.split(`/${CONTAINER}/`)[1] || '');
    if (!name) return false;
    await container.getBlockBlobClient(name).deleteIfExists();
    return true;
  } catch { return false; }
}

module.exports = { configured, uploadDataUrl, remove, CONTAINER };
