/**
 * Lightweight markup → Telegram HTML, applied to every outgoing message.
 * Write plain text; use `code` for tap-to-copy, **bold**, and [label](https://url) for links.
 * Everything else is HTML-escaped, so user/remote strings can never break formatting.
 */
import type { Bot } from "grammy";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toHtml(text: string): string {
  const parts: string[] = [];
  // tokenise code spans first so their content is not touched by bold/link rules
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const rich = (seg: string) =>
    escapeHtml(seg)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_a, label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  while ((m = re.exec(text))) {
    parts.push(rich(text.slice(last, m.index)));
    parts.push(`<code>${escapeHtml(m[1])}</code>`);
    last = m.index + m[0].length;
  }
  parts.push(rich(text.slice(last)));
  return parts.join("");
}

/** Copy-on-tap helper. */
export const code = (s: string | number) => "`" + String(s).replace(/`/g, "'") + "`";

/** Signature with Solscan link: `sig…` + [Solscan](url). */
export function sigLine(sig: string): string {
  if (sig.startsWith("DRY_RUN")) return code(sig);
  return `${code(sig)}\n[🔗 Solscan](https://solscan.io/tx/${sig})`;
}

const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);
const CAPTION_METHODS = new Set(["sendPhoto", "editMessageCaption"]);

export function installHtml(bot: Bot): void {
  bot.api.config.use((prev, method, payload, signal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    if (TEXT_METHODS.has(method) && typeof p.text === "string" && !p.parse_mode) {
      p.text = toHtml(p.text);
      p.parse_mode = "HTML";
      p.link_preview_options ??= { is_disabled: true };
    }
    if (CAPTION_METHODS.has(method) && typeof p.caption === "string" && !p.parse_mode) {
      p.caption = toHtml(p.caption);
      p.parse_mode = "HTML";
    }
    return prev(method, payload, signal);
  });
}
