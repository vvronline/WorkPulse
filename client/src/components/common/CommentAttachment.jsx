import React from 'react';
import FilePreview from '../chat/FilePreview';
import { serverURL } from '../../api';

/**
 * Renders a task-comment file attachment. Images show an inline thumbnail
 * that opens a full-screen lightbox (with download) on click; other file
 * types render as a downloadable chip. Reuses the chat FilePreview component.
 *
 * Stored file URLs are root-relative (e.g. /uploads/tenant_x/org_y/...). In
 * the Electron desktop build the app is served from a remote API host, so we
 * prefix with serverURL; on the web build serverURL is empty so the relative
 * URL is used as-is.
 */
export default function CommentAttachment({ comment }) {
  if (!comment?.file_url) return null;

  const fullUrl = comment.file_url.startsWith('http')
    ? comment.file_url
    : `${serverURL}${comment.file_url}`;

  return (
    <div style={{ marginTop: comment.content ? '0.5rem' : 0 }}>
      <FilePreview
        fileUrl={fullUrl}
        fileName={comment.file_name}
        fileType={comment.file_type}
        fileSize={comment.file_size}
        isMessage
      />
    </div>
  );
}