import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Convert markdown formatting to WhatsApp-compatible formatting.
 * Agents sometimes slip markdown despite instructions.
 */
function sanitiseForWhatsApp(text: string): string {
  let result = text;

  // **double asterisks** → *single asterisks* (WhatsApp bold)
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // __double underscores__ → _single underscores_ (WhatsApp italic)
  result = result.replace(/__([^_]+)__/g, '_$1_');

  // [text](url) → text (url) — WhatsApp doesn't render markdown links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // ## Headings → *Headings* (convert to bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  return result;
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return sanitiseForWhatsApp(text);
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
