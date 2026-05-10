/**
 * Per-tenant upload path helper.
 *
 * All disk paths and stored URLs follow the canonical layout:
 *   uploads/tenant_<tenantId>/org_<orgId>/<kind>/<filename>
 *
 * The express static middleware in server/index.js enforces that the
 * `tenant_<id>` segment of any /uploads/... URL matches the requesting
 * user's tenant, and the `org_<id>` segment matches their org. Using
 * this helper everywhere guarantees that enforcement actually applies.
 *
 * Legacy files written before the per-tenant layout still live at
 *   uploads/org_<orgId>/<kind>/<filename>
 * and continue to be served (they pass through the static middleware
 * because the tenant regex only fires when the prefix is present).
 */
const path = require('path');
const fs = require('fs');

const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');

/**
 * Build the absolute on-disk directory for a tenant+org+kind upload.
 * Creates the directory recursively if it does not already exist.
 *
 * @param {number|string} tenantId  Required. From req.tenantId.
 * @param {number|string} orgId     Required. From req.userOrgId.
 * @param {string}        kind      Logical bucket: 'chat' | 'avatars' | etc.
 * @returns {string} absolute directory path
 * @throws if tenantId or orgId is missing
 */
function getUploadDir(tenantId, orgId, kind) {
    if (!tenantId) throw new Error('uploadPath: tenantId is required');
    if (!orgId) throw new Error('uploadPath: orgId is required');
    if (!kind || typeof kind !== 'string' || /[/\\.]/.test(kind)) {
        throw new Error('uploadPath: invalid kind');
    }
    const dir = path.join(
        UPLOADS_ROOT,
        `tenant_${Number(tenantId)}`,
        `org_${Number(orgId)}`,
        kind,
    );
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Build the canonical URL path stored in the database / returned to the
 * client for a per-tenant upload.
 *
 * @param {number|string} tenantId
 * @param {number|string} orgId
 * @param {string}        kind
 * @param {string}        filename
 * @returns {string} URL path (e.g. /uploads/tenant_5/org_42/chat/foo.png)
 */
function getUploadUrl(tenantId, orgId, kind, filename) {
    if (!tenantId) throw new Error('uploadPath: tenantId is required');
    if (!orgId) throw new Error('uploadPath: orgId is required');
    if (!filename) throw new Error('uploadPath: filename is required');
    return `/uploads/tenant_${Number(tenantId)}/org_${Number(orgId)}/${kind}/${filename}`;
}

module.exports = {
    UPLOADS_ROOT,
    getUploadDir,
    getUploadUrl,
};