/** HTTP adapters and delivery side effects for chat endpoints. */
import express from "express";
import type { Request, Response } from "express";
const auth = require("../../middleware/auth");
const { loadUserContext } = require("../../middleware/rbac");
const { sendToUser, emitCallHistoryMessage } = require("../../utils/ws");
const redis = require("../../redis");
const { getUploadKey, getUploadUrl, getKeyFromUrl } = require("../../utils/uploadPath");
const { getStorage } = require("../../platform/storage");
import { enqueueChatMediaPipelineJob } from "../../jobs";
import { broadcastMediaJobUpdate, processChatMediaJob } from "../../services/chatMediaPipeline";
import { buildUploadedMediaMetadata, copyForwardedMediaMetadata } from "../../utils/chatMediaMetadata";
const { canDo, loadGroupContext } = require("../../utils/groupPerms");
import { ChatError } from "./chat.types";
import { parseMessageId, parseConversationId, parseCreateGroupConversation, parseDirectConversationUserId, parseEmoji, parseUserId } from "./chat.schema";
import { service, db, type DbLike, chatUpload, chatFilename, deleteChatObject, verifyParticipant, verifyReplyTarget, getUserOrg, emitSystemMessage } from "./chat.shared";

const router = express.Router();

const dns = require("dns").promises;
const net = require("net");

/** Reject URLs that resolve to private / loopback / link-local addresses. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  return (
    a === 127 || // loopback
    a === 10 || // private
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) // link-local / cloud metadata
  );
}

/** Minimal OpenGraph / title extraction without extra dependencies. */
function extractPreviewMeta(html: string): {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
} {
  const pick = (property: string): string | undefined => {
    // <meta property="og:x" content="..."> in either attribute order.
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
      "i",
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
      "i",
    );
    const m = html.match(re1) || html.match(re2);
    return m?.[1]?.trim() || undefined;
  };
  const decode = (s?: string) =>
    s
      ?.replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'");

  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return {
    title: decode(pick("og:title") || titleTag)?.slice(0, 200),
    description: decode(
      pick("og:description") || pick("description"),
    )?.slice(0, 300),
    image: pick("og:image")?.slice(0, 1024),
    siteName: decode(pick("og:site_name"))?.slice(0, 100),
  };
}

/**
 * GET /api/chat/link-preview?url=https://...
 * Fetch OpenGraph metadata for a URL on behalf of the SENDER.
 */

router.get("/link-preview", auth, async (req: Request, res: Response) => {
  try {
    const rawUrl = String(req.query.url || "");
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ error: "Only http/https URLs supported" });
    }

    // SSRF guard: resolve the hostname and reject private ranges.
    try {
      const { address } = await dns.lookup(parsed.hostname);
      if (isPrivateIp(address)) {
        return res.status(400).json({ error: "URL not allowed" });
      }
    } catch {
      return res.status(400).json({ error: "Could not resolve host" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let response: any;
    try {
      response = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "WorkPulseBot/1.0 (+link-preview)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return res.status(422).json({ error: "Page not reachable" });
    }
    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("text/html")) {
      return res.status(422).json({ error: "Not an HTML page" });
    }

    // Read at most ~512 KB — enough for <head> metadata.
    const reader = response.body?.getReader?.();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 512 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (html.includes("</head>")) break; // metadata is in <head>
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    } else {
      html = (await response.text()).slice(0, 512 * 1024);
    }

    const meta = extractPreviewMeta(html);
    if (!meta.title && !meta.description && !meta.image) {
      return res.status(422).json({ error: "No preview available" });
    }

    // Resolve a relative og:image against the page URL.
    if (meta.image && !/^https?:\/\//i.test(meta.image)) {
      try {
        meta.image = new URL(meta.image, parsed).toString();
      } catch {
        meta.image = undefined;
      }
    }

    res.json({
      url: parsed.toString(),
      title: meta.title || parsed.hostname,
      description: meta.description || "",
      image: meta.image || null,
      siteName: meta.siteName || parsed.hostname,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return res.status(422).json({ error: "Preview timed out" });
    }
    req.log.error({ err }, "Link preview error");
    res.status(500).json({ error: "Failed to fetch preview" });
  }
});

export default router;
